import { randomUUID } from 'node:crypto';
import { relative, isAbsolute, sep } from 'node:path';
import { Journal, problem, text, safeCode } from './state.mjs';
import { Gateway, gatewayUrl } from './gateway.mjs';
import { workspaceIdentity, validateCommands, gitEvidence, runCommand } from './evidence.mjs';

const VERSION = '0.1.0';
const MAX_EVENT_BYTES = 110 * 1024;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const interactionKey = (sessionId, requestId) => `${sessionId}\n${requestId}`;
const NOT_DISPATCHED = new Set([
  'REQUEST_CANCELLED',
  'NOT_PERMITTED',
  'BUSY',
  'SESSION_NOT_FOUND',
  'INVALID_ARGUMENTS',
  'AGENT_UNAVAILABLE',
  'REQUEST_NOT_FOUND',
]);

async function hostDeadline(operation, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(problem(code, 504)), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function redact(input, secret) {
  let json = JSON.stringify(input);
  if (secret) json = json.split(secret).join('[REDACTED]');
  json = json.replace(
    /\b(?:ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|sk-[a-zA-Z0-9_-]{20,})\b/g,
    '[REDACTED]',
  );
  json = json.replace(/Bearer [a-zA-Z0-9_.~+\/-]{20,}/g, 'Bearer [REDACTED]');
  return JSON.parse(json);
}

function modelSelection(model) {
  if (model == null) return undefined;
  if (!model || typeof model !== 'object') throw problem('INVALID_MODEL');
  const output = {
    providerId: text(model.providerId, 'PROVIDER', 300),
    modelId: text(model.modelId, 'MODEL', 300),
  };
  if (model.variant !== undefined) {
    if (typeof model.variant !== 'string' || model.variant.length > 100)
      throw problem('INVALID_VARIANT');
    output.variant = model.variant;
  }
  if (model.thinking !== undefined)
    output.thinking = { effort: text(model.thinking.effort, 'EFFORT', 100) };
  return output;
}

export function validateAnswers(question, answers) {
  const steps = question?.request?.steps;
  if (!Array.isArray(steps) || !Array.isArray(answers) || answers.length !== steps.length)
    throw problem('INVALID_ANSWERS');
  const seen = new Set();
  return answers.map((answer) => {
    const step = steps.find((item) => item.id === answer?.stepId);
    if (!step || seen.has(step.id)) throw problem('INVALID_ANSWER_STEP');
    seen.add(step.id);
    if (!Array.isArray(answer.selectedOptionIds) || typeof answer.selectedOther !== 'boolean')
      throw problem('INVALID_ANSWER');
    const options = new Set(step.options.map((item) => item.id));
    if (
      new Set(answer.selectedOptionIds).size !== answer.selectedOptionIds.length ||
      answer.selectedOptionIds.some((id) => !options.has(id))
    )
      throw problem('INVALID_ANSWER_OPTION');
    if (
      step.selectionMode === 'single' &&
      answer.selectedOptionIds.length + Number(answer.selectedOther) > 1
    )
      throw problem('INVALID_ANSWER_OPTION');
    if (
      answer.otherText !== undefined &&
      (typeof answer.otherText !== 'string' || answer.otherText.length > 10000)
    )
      throw problem('INVALID_ANSWER_TEXT');
    if (answer.skipped !== undefined && typeof answer.skipped !== 'boolean')
      throw problem('INVALID_ANSWER');
    if (
      answer.selectedOther &&
      (step.allowOther === false ||
        typeof answer.otherText !== 'string' ||
        !answer.otherText.trim())
    )
      throw problem('INVALID_ANSWER_TEXT');
    if (!answer.selectedOther && answer.otherText !== undefined)
      throw problem('INVALID_ANSWER_TEXT');
    if (answer.skipped && (answer.selectedOptionIds.length || answer.selectedOther))
      throw problem('INVALID_ANSWER');
    if (
      step.required !== false &&
      !answer.skipped &&
      !answer.selectedOptionIds.length &&
      !answer.selectedOther
    )
      throw problem('ANSWER_REQUIRED');
    return {
      stepId: step.id,
      selectedOptionIds: answer.selectedOptionIds,
      selectedOther: answer.selectedOther,
      ...(answer.otherText !== undefined ? { otherText: answer.otherText } : {}),
      ...(answer.skipped ? { skipped: true } : {}),
    };
  });
}

export class Relay {
  constructor(context, options = {}) {
    this.context = context;
    this.journal = new Journal(context.dataDir);
    this.options = options;
    this.fetch = options.fetch || fetch;
    this.enabled = false;
    this.disposed = false;
    this.gateway = null;
    this.active = null;
    this.lastError = null;
    this.connectedAt = null;
    this.tickTimer = null;
    this.ticking = false;
    this.listeners = new Set();
    this.initPromise = null;
    this.requestController = new AbortController();
    this.commandTail = Promise.resolve();
  }

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await this.journal.init();
      await this.journal.change((state) => {
        for (const job of Object.values(state.jobs)) {
          for (const receipt of Object.values(job.commands)) {
            if (receipt.status === 'started') {
              receipt.status = 'unknown';
              receipt.message = 'PROCESS_RESTARTED_AFTER_DISPATCH';
            }
          }
          if (!TERMINAL.has(job.outcome)) {
            job.outcome = 'unknown';
            job.phase = 'terminal';
            job.error = 'PROCESS_RESTARTED_WITH_UNCERTAIN_WORK';
            job.result = {
              summary: '插件重新启动；上次执行结果未知，未重新执行。',
              sessionId: job.assignment.task.sessionId,
              verificationLimitations: ['请先核对 MiniMax 会话和项目，再由管理员处理未知任务。'],
            };
          }
        }
      });
      if (this.journal.value.connection)
        this.gateway = new Gateway(this.journal.value.connection, this.fetch);
    })();
    return this.initPromise;
  }

  requireHost() {
    if (
      !this.context.agent?.run ||
      !this.context.agent?.session ||
      !this.context.agent?.reply ||
      !this.context.agent?.answer
    )
      throw problem('MINIMAX_HOST_UNAVAILABLE', 503);
    if (this.context.capabilities && !this.context.capabilities.has('agent.session'))
      throw problem('MINIMAX_HOST_TOO_OLD', 503);
  }

  notify() {
    for (const callback of this.listeners) callback();
  }

  async status() {
    await this.init();
    const state = this.journal.value;
    return {
      version: VERSION,
      enabled: this.enabled,
      connectedAt: this.connectedAt,
      lastError: this.lastError,
      hostAvailable: !!this.context.agent?.run,
      connection: state.connection
        ? { gatewayUrl: state.connection.gatewayUrl, device: state.connection.device }
        : null,
      projects: Object.values(state.projects).map((project) => ({
        ...project,
        verification: state.verification[project.workspaceKey] || [],
      })),
      jobs: Object.values(state.jobs)
        .slice(-50)
        .reverse()
        .map((job) => ({
          id: job.assignment.task.id,
          projectId: job.assignment.project.id,
          projectName: job.assignment.project.name,
          sessionId: job.assignment.task.sessionId,
          phase: job.phase,
          outcome: job.outcome,
          error: job.error,
          result: job.result,
          model: job.result?.model || job.model || job.assignment.project.model,
          modelConfirmed: !!(job.model || job.result?.model),
          startedAt: job.startedAt,
          acknowledgedSequence: job.acknowledgedSequence,
          nextSequence: job.nextSequence,
          completedReceipt: job.completedReceipt,
          reconciled: job.reconciled,
          permissions: Object.values(job.permissions),
          question: job.question,
          answering: job.answering,
          events: job.recentEvents.slice(-60),
        })),
    };
  }

  async pair(input) {
    await this.init();
    if (
      this.active ||
      Object.values(this.journal.value.jobs).some(
        (job) => (!job.completedReceipt || job.outcome === 'unknown') && !job.reconciled,
      )
    )
      throw problem('PENDING_WORK_MUST_BE_RECONCILED', 409);
    const url = gatewayUrl(text(input.gatewayUrl, 'GATEWAY_URL', 2000));
    const code = text(input.code, 'PAIRING_CODE', 200);
    const name = text(input.name, 'DEVICE_NAME', 120);
    const client = new Gateway({ gatewayUrl: url }, this.fetch);
    // A redemption whose response is lost is never retried automatically.
    const response = await client.request(
      '/v1/devices/pair',
      { code, name, version: VERSION },
      { anonymous: true, signal: this.requestController.signal },
    );
    if (!response.device?.id || typeof response.token !== 'string' || response.token.length < 16)
      throw problem('INVALID_PAIRING_RESPONSE', 502);
    await this.journal.change((state) => {
      state.connection = { gatewayUrl: url, device: response.device, token: response.token };
      state.projects = {};
      state.jobs = {};
    });
    this.gateway = new Gateway(this.journal.value.connection, this.fetch);
    this.lastError = null;
    this.notify();
    return { paired: true, device: response.device };
  }

  async bind(input) {
    await this.init();
    this.requireHost();
    if (!this.gateway) throw problem('PAIRING_REQUIRED', 409);
    const sessionId = text(input.sessionId, 'SESSION_ID', 300);
    const name = text(input.name, 'PROJECT_NAME', 120);
    // session.run permits this lookup only for this Mini App's own sessions.
    const session = await hostDeadline(
      this.context.agent.session(sessionId),
      30000,
      'HOST_READ_TIMEOUT',
    );
    if (session.sessionId !== sessionId || session.isDefaultWorkspace || !session.workspaceDir)
      throw problem('OPEN_A_PROJECT_FIRST', 409);
    const identity = await workspaceIdentity(session.workspaceDir);
    for (const reserved of [this.context.dataDir, this.context.pluginRoot]) {
      const path = relative(reserved, identity.workspaceDir);
      if (path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)))
        throw problem('PLUGIN_WORKSPACE_REJECTED');
    }
    if (
      Object.values(this.journal.value.jobs).some(
        (job) =>
          job.assignment.project.workspaceKey === identity.workspaceKey &&
          (!TERMINAL.has(job.outcome) || (job.outcome === 'unknown' && !job.reconciled)),
      )
    ) {
      throw problem('WORKSPACE_HAS_UNRESOLVED_WORK', 409);
    }
    const duplicate = Object.values(this.journal.value.projects).find(
      (project) => project.workspaceKey === identity.workspaceKey,
    );
    const body = {
      ...(input.projectId || duplicate?.id ? { projectId: input.projectId || duplicate.id } : {}),
      name,
      sessionId,
      ...identity,
      ...(session.model ? { model: modelSelection(session.model) } : {}),
    };
    const response = await this.gateway.request('/v1/worker/projects', body, {
      signal: this.requestController.signal,
    });
    if (
      !response.project?.id ||
      response.project.workspaceKey !== identity.workspaceKey ||
      response.project.sessionId !== sessionId
    )
      throw problem('INVALID_PROJECT_RESPONSE', 502);
    await this.journal.change((state) => {
      state.projects[response.project.id] = { ...response.project, needsRebind: false };
    });
    this.notify();
    return { project: response.project };
  }

  async setVerification(input) {
    await this.init();
    const project = this.journal.value.projects[text(input.projectId, 'PROJECT_ID', 300)];
    if (!project) throw problem('PROJECT_NOT_FOUND', 404);
    if (this.active) throw problem('TASK_IS_RUNNING', 409);
    const commands = validateCommands(input.commands);
    await this.journal.change((state) => {
      state.verification[project.workspaceKey] = commands;
    });
    return { saved: true };
  }

  async connect() {
    await this.init();
    this.requireHost();
    if (!this.gateway) throw problem('PAIRING_REQUIRED', 409);
    this.enabled = true;
    this.schedule(0);
    this.notify();
    return { enabled: true };
  }

  async disconnect() {
    this.enabled = false;
    // Pausing claims does not terminate active work or its lease heartbeat.
    this.notify();
    return { enabled: false, activeWorkContinues: !!this.active };
  }

  schedule(delay = 1500) {
    if (this.disposed) return;
    clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => void this.tick(), delay);
    this.tickTimer.unref();
  }

  async tick() {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      if (!this.gateway) return;
      if (this.active && !this.active.forcedUnknown) await this.heartbeat(this.active);
      // Flush local receipts even when accepting new work is paused.
      for (const job of Object.values(this.journal.value.jobs)) {
        await this.flushJob(job.assignment.task.id);
      }
      if (
        !this.active &&
        this.enabled &&
        !Object.values(this.journal.value.jobs).some(
          (job) => job.outcome === 'unknown' && !job.reconciled,
        )
      ) {
        await this.gateway.request(
          '/v1/worker/heartbeat',
          {},
          { signal: this.requestController.signal },
        );
        const response = await this.gateway.request(
          '/v1/worker/claim',
          {},
          { signal: this.requestController.signal },
        );
        if (response.assignment)
          await this.accept(response.assignment, response.leaseSeconds || 90);
      }
      this.lastError = null;
      this.connectedAt = Date.now();
    } catch (error) {
      this.lastError = safeCode(error);
      if (error.status === 401 || error.status === 403) {
        this.enabled = false;
        if (this.active) this.loseLease(this.active, 'DEVICE_ACCESS_REVOKED');
      }
    } finally {
      this.ticking = false;
      this.notify();
      if (
        this.enabled ||
        this.active ||
        Object.values(this.journal.value?.jobs || {}).some(
          (job) => !job.completedReceipt && !job.reconciled,
        )
      )
        this.schedule(this.lastError ? 5000 : 1500);
    }
  }

  async accept(assignment, leaseSeconds) {
    const { task, project, leaseToken } = assignment || {};
    if (
      !task?.id ||
      !project?.id ||
      !leaseToken ||
      task.sessionId !== project.sessionId ||
      task.workspaceKey !== project.workspaceKey
    )
      throw problem('INVALID_ASSIGNMENT', 502);
    const existing = this.journal.value.jobs[task.id];
    if (existing) {
      // A duplicate delivery must never start another Agent invocation.
      await this.flushJob(task.id);
      return;
    }
    await this.journal.change((state) => {
      state.jobs[task.id] = {
        assignment,
        phase: 'prepared',
        outcome: null,
        error: null,
        result: null,
        startedAt: Date.now(),
        leaseExpiresAt: task.leaseExpiresAt || Date.now() + leaseSeconds * 1000,
        nextSequence: 1,
        acknowledgedSequence: 0,
        events: [],
        recentEvents: [],
        commands: {},
        permissions: {},
        question: null,
        answering: false,
        completedReceipt: false,
        reconciled: false,
      };
    });
    const live = {
      id: task.id,
      controller: new AbortController(),
      forcedUnknown: null,
      heartbeatAt: 0,
      followups: new Set(),
      commandPromises: new Set(),
      waiter: null,
      finishing: false,
      acceptSteer: false,
    };
    this.active = live;
    live.leaseTimer = setInterval(() => {
      const record = this.journal.value.jobs[task.id];
      if (Date.now() >= record.leaseExpiresAt) this.loseLease(live, 'LEASE_EXPIRED');
    }, 500);
    live.leaseTimer.unref();
    live.promise = this.execute(live).catch(async (error) => {
      await this.finish(
        live,
        'unknown',
        { summary: '执行收尾失败，请核对设备。' },
        safeCode(error),
      );
    });
  }

  async heartbeat(live, force = false) {
    if (!force && Date.now() - live.heartbeatAt < 15000) return;
    const record = this.journal.value.jobs[live.id];
    let response;
    try {
      response = await this.gateway.request(
        `/v1/worker/tasks/${encodeURIComponent(live.id)}/heartbeat`,
        { leaseToken: record.assignment.leaseToken },
        { signal: this.requestController.signal },
      );
    } catch (error) {
      if (error.status === 401 || error.status === 403 || safeCode(error) === 'LEASE_EXPIRED')
        this.loseLease(live, safeCode(error));
      throw error;
    }
    if (!Number.isFinite(response.leaseExpiresAt)) throw problem('INVALID_LEASE_RESPONSE', 502);
    await this.journal.change((state) => {
      state.jobs[live.id].leaseExpiresAt = response.leaseExpiresAt;
    });
    live.heartbeatAt = Date.now();
    for (const command of response.commands || []) {
      const promise = this.command(live.id, command)
        .catch(() => {})
        .finally(() => live.commandPromises.delete(promise));
      live.commandPromises.add(promise);
    }
  }

  loseLease(live, reason) {
    if (live.forcedUnknown) return;
    live.forcedUnknown = reason;
    live.controller.abort();
    live.waiter?.resolve({ cancelled: true });
    this.lastError = reason;
    // Report uncertainty even if an unresponsive host ignores AbortSignal. Keep
    // `active` occupied until it settles, so this device cannot start other work.
    void this.journal
      .change((state) => {
        const job = state.jobs[live.id];
        if (!job) return;
        job.outcome = 'unknown';
        job.phase = 'terminal';
        job.error = reason;
        job.result = {
          summary: '已请求停止，但结果尚未确认。请核对设备；不会重新执行。',
          sessionId: job.assignment.task.sessionId,
        };
      })
      .catch(() => {
        this.lastError = 'JOURNAL_WRITE_FAILED';
      });
    this.notify();
  }

  async event(id, type, payload) {
    const connection = this.journal.value.connection;
    const cleaned = redact(payload, connection?.token);
    if (Buffer.byteLength(JSON.stringify(cleaned)) > MAX_EVENT_BYTES) {
      if (type === 'text.delta' || type === 'message.committed')
        cleaned.text = String(cleaned.text || '').slice(0, 18000);
      else throw problem('HOST_EVENT_TOO_LARGE', 502);
      cleaned.truncated = true;
    }
    await this.journal.change((state) => {
      const job = state.jobs[id];
      if (job.events.length >= 5000) throw problem('EVENT_OUTBOX_FULL', 507);
      const item = { sequence: job.nextSequence++, type, time: Date.now(), payload: cleaned };
      job.events.push(item);
      job.recentEvents.push(item);
      if (job.recentEvents.length > 100) job.recentEvents.shift();
      if (type === 'permission.requested')
        job.permissions[interactionKey(payload.sessionId, payload.requestId)] = cleaned;
      if (type === 'permission.resolved')
        delete job.permissions[interactionKey(payload.sessionId, payload.requestId)];
      if (type === 'turn.started' && payload.model) job.model = payload.model;
    });
    this.notify();
  }

  onHostEvent(live, event, commandId) {
    if (event.type === 'question.requested') return; // Send only after run resolves and answer is legal.
    live.eventsTail = (live.eventsTail || Promise.resolve())
      .then(() =>
        this.event(live.id, event.type, { ...event, ...(commandId ? { commandId } : {}) }),
      )
      .catch((error) => {
        this.loseLease(live, safeCode(error));
      });
  }

  async execute(live) {
    const assignment = this.journal.value.jobs[live.id].assignment;
    const { project, task } = assignment;
    let finalResult;
    let before;
    try {
      this.requireHost();
      const localProject = this.journal.value.projects[project.id];
      if (
        !localProject ||
        localProject.needsRebind ||
        localProject.sessionId !== project.sessionId ||
        localProject.workspaceKey !== project.workspaceKey
      )
        throw problem('PROJECT_REBIND_REQUIRED', 409);
      const actualSession = await hostDeadline(
        this.context.agent.session(task.sessionId),
        30000,
        'HOST_READ_TIMEOUT',
      );
      if (actualSession.isDefaultWorkspace) throw problem('DEFAULT_WORKSPACE_REJECTED');
      const identity = await workspaceIdentity(actualSession.workspaceDir);
      if (
        identity.workspaceKey !== project.workspaceKey ||
        actualSession.sessionId !== task.sessionId
      )
        throw problem('WORKSPACE_BINDING_CHANGED');
      const workspaceDir = identity.workspaceDir;
      await this.heartbeat(live, true);
      before = await (this.options.gitEvidence || gitEvidence)(
        workspaceDir,
        live.controller.signal,
      );
      if (live.controller.signal.aborted) throw problem(live.forcedUnknown || 'REQUEST_CANCELLED');
      await this.journal.change((state) => {
        state.jobs[live.id].phase = 'running';
      });
      const prompt = [
        'You are executing a task explicitly submitted by the owner through CodeRelay.',
        'Work in the bound project. Follow its instructions and the host permission policy. Do not change CodeRelay credentials or its task journal.',
        'Report exactly which checks ran and which could not run; do not infer a passing test from an unfinished command.',
        '\nOwner task:\n',
        task.prompt,
        '\nAcceptance criteria:\n',
        ...(task.acceptanceCriteria || []).map((criterion) => `- ${criterion}`),
      ].join('\n');
      if (prompt.length > 100000) throw problem('TASK_PROMPT_TOO_LARGE');
      live.hostDispatchAttempted = true;
      live.acceptSteer = true;
      let result = await this.context.agent.run(
        {
          sessionId: task.sessionId,
          text: prompt,
          ...(project.model ? { model: project.model } : {}),
        },
        { signal: live.controller.signal, onEvent: (event) => this.onHostEvent(live, event) },
      );
      for (;;) {
        await live.eventsTail;
        if (result.pendingQuestion && !live.controller.signal.aborted) {
          const question = { sessionId: result.sessionId, ...result.pendingQuestion };
          await this.journal.change((state) => {
            const job = state.jobs[live.id];
            job.phase = 'waiting_input';
            job.question = question;
            job.answering = false;
          });
          const waiting = new Promise((resolve) => {
            live.waiter = { resolve };
          });
          await this.event(live.id, 'question.requested', {
            type: 'question.requested',
            ...question,
          });
          const response = await waiting;
          live.waiter = null;
          if (response.cancelled) {
            await this.journal.change((state) => {
              state.projects[project.id].needsRebind = true;
            });
            live.forcedUnknown ||= 'PAUSED_QUESTION_CANCEL_REQUIRES_REBIND';
            result = {
              ...result,
              text: '已停止本插件后续执行；宿主保留暂停的问题，重新接单前请重新绑定项目会话。',
            };
            break;
          }
          try {
            result = await this.context.agent.answer(
              {
                sessionId: question.sessionId,
                requestId: question.requestId,
                answers: response.answers,
              },
              {
                signal: live.controller.signal,
                onEvent: (event) => this.onHostEvent(live, event, response.commandId),
              },
            );
            if (this.journal.value.jobs[live.id].commands[response.commandId].local) {
              await this.event(live.id, 'question.answered', {
                sessionId: question.sessionId,
                requestId: question.requestId,
              });
            }
            await this.receipt(live.id, response.commandId, 'applied');
            await this.journal.change((state) => {
              state.jobs[live.id].question = null;
              state.jobs[live.id].answering = false;
              state.jobs[live.id].phase = 'running';
            });
          } catch (error) {
            await this.receipt(
              live.id,
              response.commandId,
              !NOT_DISPATCHED.has(safeCode(error)) ? 'unknown' : 'rejected',
              safeCode(error),
            );
            throw error;
          }
          continue;
        }
        // Steering may become a separate turn if the original turn just ended.
        // Its questionnaire is processed through the same continuation loop.
        while (live.followups.size) await Promise.allSettled([...live.followups]);
        if (live.followupResult) {
          result = live.followupResult;
          live.followupResult = null;
          continue;
        }
        break;
      }
      live.acceptSteer = false;
      await live.eventsTail;
      finalResult = {
        summary: String(result.text || '').slice(0, 100000),
        sessionId: result.sessionId || task.sessionId,
        model: result.model || this.journal.value.jobs[live.id].model,
        verification: [],
        verificationLimitations: [
          'Agent 的最终文字不是独立测试证据；仅以下本地验证命令的真实退出码可作为验证结果。',
        ],
      };
      let outcome =
        result.status === 'finished'
          ? 'succeeded'
          : result.status === 'aborted'
            ? 'cancelled'
            : 'failed';
      const commands = this.journal.value.verification[project.workspaceKey] || [];
      if (outcome === 'succeeded' && task.runVerification) {
        await this.journal.change((state) => {
          state.jobs[live.id].phase = 'verifying';
        });
        if (!commands.length)
          finalResult.verificationLimitations.push('此项目未配置本地验证命令，未执行独立测试。');
        for (const command of commands) {
          if (live.controller.signal.aborted) break;
          await this.event(live.id, 'verification.started', { name: command.name });
          const check = await (this.options.runCommand || runCommand)(command.file, command.args, {
            cwd: workspaceDir,
            signal: live.controller.signal,
            timeoutMs: command.timeoutMs,
            maxBytes: 32768,
          });
          const report = { name: command.name, ...check };
          finalResult.verification.push(report);
          await this.event(live.id, 'verification.finished', report);
          if (check.errorCode === 'PROCESS_CLEANUP_UNCONFIRMED')
            this.loseLease(live, 'VERIFICATION_CLEANUP_UNCONFIRMED');
          if (check.exitCode !== 0 || check.timedOut || check.cancelled || check.errorCode)
            outcome = check.cancelled ? 'cancelled' : 'failed';
        }
      } else if (!task.runVerification)
        finalResult.verificationLimitations.push('调用方未要求运行本地独立验证。');
      finalResult.evidence = {
        before,
        after: await (this.options.gitEvidence || gitEvidence)(
          workspaceDir,
          live.controller.signal,
        ),
      };
      if (live.forcedUnknown) outcome = 'unknown';
      await this.finish(
        live,
        outcome,
        finalResult,
        live.forcedUnknown || result.error?.code || null,
      );
    } catch (error) {
      const code = safeCode(error);
      const knownNonDispatch = [
        'REQUEST_CANCELLED',
        'NOT_PERMITTED',
        'BUSY',
        'SESSION_NOT_FOUND',
        'INVALID_ARGUMENTS',
        'AGENT_UNAVAILABLE',
      ];
      const unknown =
        live.forcedUnknown ||
        code === 'AGENT_OUTCOME_UNKNOWN' ||
        (live.hostDispatchAttempted && !knownNonDispatch.includes(code));
      const cancelled = code === 'REQUEST_CANCELLED' && !unknown;
      await this.finish(
        live,
        unknown ? 'unknown' : cancelled ? 'cancelled' : 'failed',
        finalResult || {
          summary: unknown
            ? '执行结果未知；未自动重新执行，请核对 MiniMax 会话。'
            : '任务未完成，请查看错误代码。',
          sessionId: task.sessionId,
          evidence: { before },
          verificationLimitations: ['宿主未返回完整完成证据。'],
        },
        live.forcedUnknown || code,
      );
    }
  }

  async finish(live, outcome, result, error) {
    if (live.finishing) return;
    live.finishing = true;
    await this.commandTail;
    await live.eventsTail;
    clearInterval(live.leaseTimer);
    clearTimeout(live.cancelTimer);
    if (live.forcedUnknown) {
      outcome = 'unknown';
      error = live.forcedUnknown;
    }
    let clean = redact(result, this.journal.value.connection?.token);
    if (Buffer.byteLength(JSON.stringify(clean)) > 480 * 1024) {
      clean.summary = String(clean.summary || '').slice(0, 40000);
      for (const command of [
        ...(clean.verification || []),
        ...Object.values(clean.evidence?.before || {}),
        ...Object.values(clean.evidence?.after || {}),
      ]) {
        if (!command || typeof command !== 'object') continue;
        if (typeof command.stdout === 'string') command.stdout = command.stdout.slice(0, 8000);
        if (typeof command.stderr === 'string') command.stderr = command.stderr.slice(0, 8000);
        if (Array.isArray(command.args))
          command.args = command.args.map((arg) => String(arg).slice(0, 500));
        command.truncated = true;
      }
      clean.verificationLimitations ||= [];
      clean.verificationLimitations.push(
        '结果较大，部分输出已截断；真实退出码保留。完整代码差异请在本地查看。',
      );
    }
    await this.journal.change((state) => {
      const job = state.jobs[live.id];
      job.outcome = outcome;
      job.phase = 'terminal';
      job.result = clean;
      job.error = error || null;
      job.permissions = {};
      job.answering = false;
    });
    if (this.active === live) this.active = null;
    this.notify();
    this.schedule(0);
  }

  command(id, command, local = false) {
    const operation = this.commandTail.then(() => this.applyCommand(id, command, local));
    this.commandTail = operation.catch(() => {});
    return operation;
  }

  async applyCommand(id, command, local = false) {
    const live = this.active;
    const record = this.journal.value.jobs[id];
    if (!record) throw problem('TASK_NOT_FOUND', 404);
    const commandId = text(command.id, 'COMMAND_ID', 300);
    const previous = record.commands[commandId];
    if (previous) return { status: previous.status }; // Never replay started or uncertain commands.
    if (!live || live.id !== id || live.finishing) throw problem('TASK_NOT_RUNNING', 409);
    if ((live.forcedUnknown || live.controller.signal.aborted) && command.kind !== 'cancel')
      throw problem('TASK_OUTCOME_UNKNOWN', 409);
    if (!['cancel', 'steer', 'reply', 'answer'].includes(command.kind))
      throw problem('INVALID_COMMAND');
    const payload = command.payload || {};
    await this.journal.change((state) => {
      state.jobs[id].commands[commandId] = {
        status: 'started',
        kind: command.kind,
        local,
        message: null,
        acknowledged: local,
      };
    });
    let hostCallAttempted = false;
    try {
      if (command.kind === 'cancel') {
        live.controller.abort();
        live.waiter?.resolve({ cancelled: true });
        if (!live.cancelTimer) {
          live.cancelTimer = setTimeout(() => {
            if (!live.finishing) this.loseLease(live, 'CANCELLATION_NOT_CONFIRMED');
          }, 15000);
          live.cancelTimer.unref();
        }
        await this.receipt(id, commandId, 'applied', 'CANCELLATION_REQUESTED_NOT_YET_CONFIRMED');
      } else if (command.kind === 'reply') {
        const key = interactionKey(payload.sessionId, payload.requestId);
        if (
          !this.journal.value.jobs[id].permissions[key] ||
          !['allowOnce', 'deny'].includes(payload.decision)
        )
          throw problem('PERMISSION_NOT_PENDING', 409);
        hostCallAttempted = true;
        await hostDeadline(
          this.context.agent.reply({
            sessionId: payload.sessionId,
            requestId: payload.requestId,
            decision: payload.decision,
          }),
          30000,
          'AGENT_OUTCOME_UNKNOWN',
        );
        if (local)
          await this.event(id, 'permission.resolved', {
            sessionId: payload.sessionId,
            requestId: payload.requestId,
            decision: payload.decision,
          });
        else
          await this.journal.change((state) => {
            delete state.jobs[id].permissions[key];
          });
        await this.receipt(id, commandId, 'applied');
      } else if (command.kind === 'answer') {
        const question = this.journal.value.jobs[id].question;
        if (
          !question ||
          !live.waiter ||
          this.journal.value.jobs[id].answering ||
          question.sessionId !== payload.sessionId ||
          question.requestId !== payload.requestId
        )
          throw problem('QUESTION_NOT_READY', 409);
        if (question.request.expiresAt && question.request.expiresAt <= Date.now())
          throw problem('QUESTION_EXPIRED', 409);
        const answers = validateAnswers(question, payload.answers);
        await this.journal.change((state) => {
          state.jobs[id].answering = true;
        });
        live.waiter.resolve({ answers, commandId });
        // Receipt is marked applied by the answer continuation only when its outcome is known.
      } else {
        if (!live.acceptSteer) throw problem('TASK_NOT_ACCEPTING_STEERING', 409);
        if (this.journal.value.jobs[id].question)
          throw problem('QUESTION_MUST_BE_ANSWERED_FIRST', 409);
        const message = text(payload.text, 'STEERING_TEXT', 30000);
        const promise = this.context.agent
          .run(
            { sessionId: record.assignment.task.sessionId, text: message, whenBusy: 'steer' },
            {
              signal: live.controller.signal,
              onEvent: (event) => this.onHostEvent(live, event, commandId),
            },
          )
          .then(async (result) => {
            if (result.status !== 'steered') {
              live.followupResult = result;
            }
            await this.receipt(id, commandId, 'applied');
          })
          .catch(async (error) => {
            const uncertain = !NOT_DISPATCHED.has(safeCode(error));
            await this.receipt(id, commandId, uncertain ? 'unknown' : 'rejected', safeCode(error));
            if (uncertain) this.loseLease(live, safeCode(error));
          })
          .finally(() => live.followups.delete(promise));
        live.followups.add(promise);
      }
      this.notify();
      return { status: this.journal.value.jobs[id].commands[commandId].status };
    } catch (error) {
      const uncertain =
        safeCode(error) === 'AGENT_OUTCOME_UNKNOWN' ||
        (hostCallAttempted && !NOT_DISPATCHED.has(safeCode(error)));
      await this.receipt(id, commandId, uncertain ? 'unknown' : 'rejected', safeCode(error));
      if (uncertain) this.loseLease(live, safeCode(error));
      throw error;
    }
  }

  async localCommand(id, input) {
    return this.command(
      id,
      { id: `local_${randomUUID()}`, kind: input.kind, payload: input.payload },
      true,
    );
  }

  async receipt(id, commandId, status, message = null) {
    await this.journal.change((state) => {
      const receipt = state.jobs[id].commands[commandId];
      receipt.status = status;
      receipt.message = message;
    });
    this.notify();
  }

  async flushJob(id) {
    let record = this.journal.value.jobs[id];
    if (record.reconciled || !this.gateway) return;
    const path = `/v1/worker/tasks/${encodeURIComponent(id)}`;
    for (const [commandId, receipt] of Object.entries(record.commands)) {
      if (receipt.local || receipt.acknowledged || receipt.status === 'started') continue;
      await this.gateway.request(
        `${path}/commands/${encodeURIComponent(commandId)}/ack`,
        {
          leaseToken: record.assignment.leaseToken,
          status: receipt.status,
          ...(receipt.message ? { message: receipt.message } : {}),
        },
        { signal: this.requestController.signal },
      );
      await this.journal.change((state) => {
        state.jobs[id].commands[commandId].acknowledged = true;
      });
    }
    if (record.events.length) {
      const batch = [];
      let bytes = 64;
      for (const event of record.events) {
        const size = Buffer.byteLength(JSON.stringify(event)) + 1;
        if (batch.length >= 100 || bytes + size > 128 * 1024) break;
        batch.push(event);
        bytes += size;
      }
      if (!batch.length) throw problem('EVENT_TOO_LARGE', 500);
      const response = await this.gateway.request(
        `${path}/events`,
        { leaseToken: record.assignment.leaseToken, events: batch },
        { signal: this.requestController.signal },
      );
      if (
        !Number.isSafeInteger(response.acknowledgedSequence) ||
        response.acknowledgedSequence < batch.at(-1).sequence ||
        response.acknowledgedSequence >= record.nextSequence
      )
        throw problem('INVALID_EVENT_ACK', 502);
      await this.journal.change((state) => {
        const job = state.jobs[id];
        job.acknowledgedSequence = response.acknowledgedSequence;
        job.events = job.events.filter((event) => event.sequence > response.acknowledgedSequence);
      });
      record = this.journal.value.jobs[id];
    }
    if (TERMINAL.has(record.outcome) && !record.completedReceipt && !record.events.length) {
      const response = await this.gateway.request(
        `${path}/complete`,
        {
          leaseToken: record.assignment.leaseToken,
          outcome: record.outcome,
          result: record.result,
          ...(record.error ? { error: record.error } : {}),
        },
        { signal: this.requestController.signal },
      );
      if (!response.task || response.task.id !== id)
        throw problem('INVALID_COMPLETE_RESPONSE', 502);
      await this.journal.change((state) => {
        state.jobs[id].completedReceipt = true;
      });
    }
  }

  async reconcileStatus(id) {
    await this.init();
    const record = this.journal.value.jobs[id];
    if (!record || record.outcome !== 'unknown') throw problem('TASK_NOT_UNKNOWN', 409);
    const response = await this.gateway.request(
      `/v1/worker/tasks/${encodeURIComponent(id)}`,
      undefined,
      { signal: this.requestController.signal },
    );
    if (
      !response.task ||
      response.task.id !== id ||
      !['succeeded', 'failed', 'cancelled'].includes(response.task.status)
    )
      throw problem('ADMIN_RECONCILIATION_REQUIRED', 409);
    await this.journal.change((state) => {
      const job = state.jobs[id];
      job.reconciled = true;
      job.completedReceipt = true;
      job.error = `ADMIN_RECONCILED_${response.task.status.toUpperCase()}`;
    });
    this.notify();
    return { reconciled: true, task: response.task };
  }

  async dispose() {
    this.disposed = true;
    this.enabled = false;
    clearTimeout(this.tickTimer);
    if (this.active) {
      const live = this.active;
      this.loseLease(live, 'PLUGIN_STOPPED_DURING_TASK');
      clearInterval(live.leaseTimer);
      // Write uncertainty before waiting: the host may terminate the entry process at any time.
      await this.journal.change((state) => {
        const job = state.jobs[live.id];
        job.outcome = 'unknown';
        job.phase = 'terminal';
        job.error = 'PLUGIN_STOPPED_DURING_TASK';
        job.result = {
          summary: '插件停止，任务已请求取消；结果待核对。',
          sessionId: job.assignment.task.sessionId,
        };
      });
      await Promise.race([live.promise, pause(1000)]);
    }
    this.requestController.abort();
    await this.journal.flush();
    this.listeners.clear();
  }
}
