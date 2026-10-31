'use strict';
const $ = (id) => document.getElementById(id);
const host = window.mcode?.miniapp;
let snapshot;
let renderKey = '';
let refreshBusy = false;
const pendingActions = new Set();
const questionDrafts = new Map();
const titles = {
  running: '执行中',
  prepared: '准备执行',
  verifying: '正在独立验证',
  waiting_input: '等待你的输入',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '结果待核对',
  terminal: '已结束',
};
const messages = {
  OPEN_A_PROJECT_FIRST: '请先在 MiniMax Code 中打开目标项目，再从该项目会话打开本插件。',
  PAIRING_REQUIRED: '请先配对设备。',
  MINIMAX_HOST_UNAVAILABLE: '此窗口无法使用 MiniMax Agent，请在桌面应用中打开插件。',
  MINIMAX_HOST_TOO_OLD: '请更新 MiniMax Code 至 3.1.6 或更高版本。',
  WORKSPACE_HAS_UNRESOLVED_WORK: '此目录仍有正在执行或结果未知的任务，请先处理。',
  ADMIN_RECONCILIATION_REQUIRED: '服务端任务仍是未知状态，请管理员核对实际设备后处理。',
  HTTPS_REQUIRED: '远程服务需要 HTTPS；仅本机 localhost 可以使用 HTTP。',
  NETWORK_UNAVAILABLE: '暂时无法连接服务，请检查地址和网络。',
  PERMISSION_NOT_PENDING: '这项审批已处理或不属于当前任务，请刷新。',
  QUESTION_NOT_READY: '问题暂时不能作答，原任务可能尚未暂停，请刷新。',
  JOURNAL_INVALID: '本地任务日志无法读取，已停止执行，请保留文件进行检查。',
  ANSWER_REQUIRED: '请选择答案、填写允许的其他回答，或明确勾选“跳过此题”。',
  INVALID_ANSWER_TEXT: '请检查其他回答是否允许填写，且内容不能为空。',
  INVALID_VERIFICATION_JSON: '验证命令不是有效的 JSON，请检查括号、引号和逗号。',
  PLUGIN_STOPPED_DURING_TASK: '插件在任务执行时停止，结果需要核对。',
  PROCESS_RESTARTED_WITH_UNCERTAIN_WORK: '插件已经重启，上次执行结果需要核对。',
  LEASE_EXPIRED: '与服务的执行租约已经失效，已请求停止，结果需要核对。',
  AGENT_OUTCOME_UNKNOWN: 'MiniMax 未能确认执行结果，请先核对工作会话和项目。',
};
function notice(message) {
  $('notice').textContent = message;
}
function errorText(error) {
  const code =
    error.code ||
    (/^[A-Z][A-Z0-9_]{0,99}$/.test(error.message || '') ? error.message : 'OPERATION_FAILED');
  return (
    messages[code] || `操作未完成：${code}。请检查状态后再试；配对或执行结果未知时不要重复提交。`
  );
}
async function api(path, body) {
  const response = await fetch(
    path,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error?.code || 'REQUEST_FAILED'), {
      code: result.error?.code,
    });
  return result;
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function actionBusy(key, value) {
  if (value) pendingActions.add(key);
  else pendingActions.delete(key);
  for (const element of document.querySelectorAll('[data-action-key]'))
    if (element.dataset.actionKey === key)
      element.disabled = value || element.dataset.keepDisabled === 'true';
  if (snapshot) syncControls();
}
async function perform(key, action) {
  if (pendingActions.has(key)) return;
  actionBusy(key, true);
  try {
    await action();
    await refresh(true);
  } catch (error) {
    notice(errorText(error));
    await refresh(true);
  } finally {
    actionBusy(key, false);
  }
}
function button(label, action, className = 'secondary compact', key) {
  const element = node('button', label, className);
  element.type = 'button';
  if (key) {
    element.dataset.actionKey = key;
    element.disabled = pendingActions.has(key);
  }
  element.addEventListener('click', async () => {
    if (key) {
      await perform(key, action);
      return;
    }
    element.disabled = true;
    try {
      await action();
      await refresh(true);
    } catch (error) {
      notice(errorText(error));
    } finally {
      element.disabled = false;
    }
  });
  return element;
}
function detail(label, value) {
  const element = node('details');
  element.append(
    node('summary', label),
    node('pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
  );
  return element;
}
async function command(job, kind, payload) {
  return api('/api/command', { taskId: job.id, kind, payload });
}
async function openSession(sessionId) {
  if (!host?.agent?.open) throw new Error('MINIMAX_HOST_UNAVAILABLE');
  await host.agent.open(sessionId);
}

function renderProjects(projects) {
  $('projects').replaceChildren();
  for (const project of projects) {
    const element = node('article', undefined, 'item');
    element.append(node('h3', project.name), node('div', project.workspaceDir, 'path'));
    const model = project.model;
    element.append(
      node(
        'p',
        model
          ? `${model.providerId} / ${model.modelId}${model.thinking?.effort ? ` · ${model.thinking.effort}` : ''}`
          : '模型：继承已绑定会话',
        'hint',
      ),
    );
    if (project.needsRebind)
      element.append(
        node('p', '此会话保留已暂停的问题。继续接单前请在项目中重新绑定。', 'warning'),
      );
    const actions = node('div', undefined, 'actions');
    actions.append(
      button('打开工作会话', async () => openSession(project.sessionId)),
      button('编辑验证命令', async () => {
        $('verification-project').value = project.id;
        $('verification-json').value = JSON.stringify(project.verification || [], null, 2);
        $('verification-form').closest('details').open = true;
        $('verification-json').focus();
      }),
    );
    element.append(actions);
    $('projects').append(element);
  }
  if (!projects.length) $('projects').append(node('p', '尚未绑定项目', 'empty'));
  const selected = $('verification-project').value;
  $('verification-project').replaceChildren(
    ...projects.map((project) => {
      const option = node('option', project.name);
      option.value = project.id;
      return option;
    }),
  );
  if (projects.some((project) => project.id === selected))
    $('verification-project').value = selected;
}

function questionForm(job) {
  const question = job.question;
  const form = node('form', undefined, 'approval');
  const draftKey = JSON.stringify([job.id, question.requestId]);
  const draft = questionDrafts.get(draftKey) || {};
  form.dataset.draftKey = draftKey;
  form.append(node('h4', question.request.title || 'MiniMax 需要你的输入'));
  if (question.request.modePayload)
    form.append(detail('计划或补充内容', question.request.modePayload));
  const controls = [];
  for (const step of question.request.steps || []) {
    const field = node('fieldset', undefined, 'question-step');
    field.append(node('legend', step.question));
    if (step.description) field.append(node('p', step.description, 'hint'));
    const options = [];
    const saved = draft[step.id] || {};
    for (const option of step.options || []) {
      const label = node('label', undefined, 'option');
      const input = document.createElement('input');
      input.type = step.selectionMode === 'multiple' ? 'checkbox' : 'radio';
      input.name = JSON.stringify([job.id, question.requestId, step.id]);
      input.value = option.id;
      input.id = JSON.stringify([job.id, question.requestId, step.id, option.id]);
      input.checked = (saved.selectedOptionIds || []).includes(option.id);
      label.append(
        input,
        node('span', option.label + (option.description ? ` — ${option.description}` : '')),
      );
      field.append(label);
      options.push(input);
    }
    let otherChoice, other;
    if (step.allowOther !== false) {
      const label = node('label', undefined, 'option');
      otherChoice = document.createElement('input');
      otherChoice.type = step.selectionMode === 'multiple' ? 'checkbox' : 'radio';
      otherChoice.name = JSON.stringify([job.id, question.requestId, step.id]);
      otherChoice.id = JSON.stringify([job.id, question.requestId, step.id, 'other-choice']);
      otherChoice.checked = !!saved.selectedOther;
      label.append(otherChoice, node('span', '其他回答'));
      field.append(label);
      other = node('textarea');
      other.rows = 2;
      other.placeholder = '填写其他回答';
      other.id = JSON.stringify([job.id, question.requestId, step.id, 'other-text']);
      other.setAttribute('aria-label', `${step.question}：其他回答`);
      other.value = saved.otherText || '';
      field.append(other);
    }
    const skip = node('input');
    skip.type = 'checkbox';
    skip.checked = !!saved.skipped;
    skip.id = JSON.stringify([job.id, question.requestId, step.id, 'skip']);
    const skipLabel = node('label', undefined, 'option skip');
    skipLabel.append(skip, node('span', '跳过此题'));
    field.append(skipLabel);
    const update = () => {
      for (const input of options) input.disabled = !!job.answering || skip.checked;
      if (otherChoice) otherChoice.disabled = !!job.answering || skip.checked;
      if (other) other.disabled = !!job.answering || skip.checked || !otherChoice.checked;
      skip.disabled = !!job.answering;
    };
    field.addEventListener('change', update);
    update();
    controls.push({ step, options, otherChoice, other, skip });
    form.append(field);
  }
  const saveDraft = () =>
    questionDrafts.set(
      draftKey,
      Object.fromEntries(
        controls.map(({ step, options, otherChoice, other, skip }) => [
          step.id,
          {
            selectedOptionIds: options.filter((input) => input.checked).map((input) => input.value),
            selectedOther: !!otherChoice?.checked,
            otherText: other?.value || '',
            skipped: skip.checked,
          },
        ]),
      ),
    );
  form.addEventListener('input', saveDraft);
  form.addEventListener('change', saveDraft);
  const answerKey = JSON.stringify(['answer', job.id, question.requestId]);
  const submit = node('button', job.answering ? '正在继续执行…' : '提交回答');
  submit.type = 'submit';
  submit.dataset.actionKey = answerKey;
  submit.dataset.keepDisabled = String(!!job.answering);
  submit.disabled = !!job.answering || pendingActions.has(answerKey);
  form.append(submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (job.answering || pendingActions.has(answerKey)) return;
    actionBusy(answerKey, true);
    try {
      const answers = controls.map(({ step, options, otherChoice, other, skip }) => {
        const answer = {
          stepId: step.id,
          selectedOptionIds: skip.checked
            ? []
            : options.filter((input) => input.checked).map((input) => input.value),
          selectedOther: !skip.checked && !!otherChoice?.checked,
          ...(skip.checked ? { skipped: true } : {}),
        };
        if (answer.selectedOther) {
          answer.otherText = other.value.trim();
          if (!answer.otherText) throw new Error('INVALID_ANSWER_TEXT');
        }
        if (
          step.required !== false &&
          !answer.skipped &&
          !answer.selectedOptionIds.length &&
          !answer.selectedOther
        )
          throw new Error('ANSWER_REQUIRED');
        return answer;
      });
      await command(job, 'answer', {
        sessionId: question.sessionId,
        requestId: question.requestId,
        answers,
      });
      notice('回答已送交；继续执行的结果将在任务中更新。');
      await refresh(true);
    } catch (error) {
      notice(errorText(error));
    } finally {
      actionBusy(answerKey, false);
    }
  });
  return form;
}

function renderJobs(jobs) {
  const nextKey = JSON.stringify(
    jobs.map((job) => [
      job.id,
      job.phase,
      job.outcome,
      job.error,
      job.reconciled,
      job.answering,
      job.question?.requestId,
      job.permissions.map((item) => [item.sessionId, item.requestId]),
      job.model,
      job.modelConfirmed,
      job.result?.summary,
      Math.floor(job.nextSequence / 20),
    ]),
  );
  if (nextKey === renderKey) return;
  renderKey = nextKey;
  const activeInput = document.activeElement;
  const focus = activeInput?.closest('form.approval')
    ? { id: activeInput.id, start: activeInput.selectionStart, end: activeInput.selectionEnd }
    : null;
  const liveDrafts = new Set(
    jobs
      .filter((job) => job.question && !job.outcome)
      .map((job) => JSON.stringify([job.id, job.question.requestId])),
  );
  for (const key of questionDrafts.keys()) if (!liveDrafts.has(key)) questionDrafts.delete(key);
  $('jobs').replaceChildren();
  if (!jobs.length) {
    $('jobs').append(node('p', '尚未收到任务。连接后可从 ChatGPT 或 Claude 提交。', 'empty'));
    return;
  }
  for (const job of jobs) {
    const item = node('article', undefined, 'item');
    item.append(
      node(
        'span',
        job.reconciled ? '已核对' : titles[job.outcome || job.phase] || job.phase,
        'status',
      ),
      node('h3', job.projectName),
      node('div', job.id, 'mono'),
    );
    if (job.model)
      item.append(
        node(
          'p',
          `${job.modelConfirmed ? '执行模型' : '绑定模型'}：${job.model.providerId} / ${job.model.modelId}${job.model.thinking?.effort ? ` · ${job.model.thinking.effort}` : ''}`,
          'hint',
        ),
      );
    if (job.error && !job.reconciled)
      item.append(node('p', messages[job.error] || `状态代码：${job.error}`, 'warning'));
    if (job.outcome === 'unknown' && !job.reconciled)
      item.append(
        node(
          'p',
          '不会重新执行此任务。请先核对 MiniMax 工作会话和项目的实际结果，再由服务管理员完成核对。',
          'hint',
        ),
      );
    const actions = node('div', undefined, 'actions');
    actions.append(button('查看 MiniMax 会话', async () => openSession(job.sessionId)));
    if (!job.outcome) {
      actions.append(
        button(
          '取消任务',
          async () => {
            await command(job, 'cancel', {});
            notice('已请求停止；只有宿主确认停止后才会显示已取消。');
          },
          'danger compact',
          `cancel:${job.id}`,
        ),
      );
    }
    if (job.outcome === 'unknown' && !job.reconciled)
      actions.append(
        button('检查管理员处理结果', async () => {
          await api('/api/reconcile-status', { taskId: job.id });
          notice('服务端已完成核对，记录已同步。');
        }),
      );
    item.append(actions);
    for (const permission of job.outcome ? [] : job.permissions) {
      const card = node('div', undefined, 'approval');
      card.append(node('h4', `允许执行 ${permission.toolName}？`), node('p', permission.reason));
      if (permission.toolInput) card.append(detail('操作内容', permission.toolInput));
      const row = node('div', undefined, 'actions');
      for (const [label, decision] of [
        ['仅允许本次', 'allowOnce'],
        ['拒绝', 'deny'],
      ])
        row.append(
          button(
            label,
            async () => {
              await command(job, 'reply', {
                sessionId: permission.sessionId,
                requestId: permission.requestId,
                decision,
              });
              notice('审批决定已送交 MiniMax。');
            },
            decision === 'deny' ? 'secondary compact' : 'compact',
            JSON.stringify(['permission', job.id, permission.sessionId, permission.requestId]),
          ),
        );
      card.append(row);
      item.append(card);
    }
    if (job.question && !job.outcome) item.append(questionForm(job));
    if (job.result) {
      item.append(detail('任务结果与独立验证', job.result));
    }
    if (job.events?.length) {
      const events = node('details');
      events.append(node('summary', '最近事件'));
      const list = node('div', undefined, 'events');
      for (const event of job.events.slice(-20))
        list.append(
          node(
            'p',
            `#${event.sequence} ${event.type}${event.payload?.name ? ` · ${event.payload.name}` : ''}`,
          ),
        );
      events.append(list);
      item.append(events);
    }
    $('jobs').append(item);
  }
  if (focus?.id) {
    const next = $(focus.id);
    if (next && !next.disabled) {
      next.focus({ preventScroll: true });
      if (typeof focus.start === 'number' && next.tagName === 'TEXTAREA')
        next.setSelectionRange(focus.start, focus.end);
    }
  }
}

function syncControls() {
  $('pair-form').hidden = !!snapshot.connection;
  $('pair-form').querySelector('button').disabled = pendingActions.has('pair');
  $('connect').disabled =
    !snapshot.connection ||
    snapshot.enabled ||
    !host?.agent ||
    pendingActions.has('device-control');
  $('pause').disabled = !snapshot.enabled || pendingActions.has('device-control');
  $('bind').disabled = !snapshot.connection || !host?.agent?.create || pendingActions.has('bind');
}

async function refresh(force = false) {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    snapshot = await api('/api/status');
    $('host-missing').hidden = !!host?.agent?.create;
    $('connection-state').textContent = snapshot.lastError
      ? '连接待恢复'
      : snapshot.enabled
        ? '接单中'
        : snapshot.connection
          ? '已配对 · 暂停接单'
          : '未配对';
    $('device-summary').textContent = snapshot.connection
      ? `${snapshot.connection.device.name} · ${snapshot.connection.gatewayUrl}`
      : '输入 CodeRelay 服务地址和管理员生成的一次性配对码。';
    syncControls();
    if (snapshot.lastError)
      notice(messages[snapshot.lastError] || `连接状态：${snapshot.lastError}。任务不会自动重跑。`);
    renderProjects(snapshot.projects);
    if (force) renderKey = '';
    renderJobs(snapshot.jobs);
  } catch (error) {
    notice(errorText(error));
  } finally {
    refreshBusy = false;
  }
}
$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await perform('pair', async () => {
    const body = {
      gatewayUrl: $('gateway-url').value,
      name: $('device-name').value,
      code: $('pairing-code').value,
    };
    $('pairing-code').value = '';
    try {
      await api('/api/pair', body);
    } finally {
      body.code = '';
    }
    notice('设备已配对。请绑定项目，再开始接单。');
  });
});
$('bind').addEventListener('click', async () => {
  await perform('bind', async () => {
    const name = $('project-name').value.trim();
    if (!name) {
      notice('请先填写项目名称。');
      return;
    }
    if (!host?.agent?.create) throw new Error('MINIMAX_HOST_UNAVAILABLE');
    // Exactly one create. A lost response may have created a session; never auto-repeat.
    const created = await host.agent.create();
    await api('/api/projects/bind', { name, sessionId: created.sessionId });
    notice('项目已绑定。工作将使用当前项目派生的专用会话。');
    await refresh(true);
  });
});
$('connect').addEventListener('click', async () =>
  perform('device-control', async () => {
    await api('/api/connect', {});
    notice('已开始接单，保持 MiniMax Code 和插件运行。');
  }),
);
$('pause').addEventListener('click', async () =>
  perform('device-control', async () => {
    await api('/api/pause', {});
    notice('已暂停新任务；正在执行的任务继续运行。');
  }),
);
$('refresh').addEventListener('click', () => void refresh(true));
$('verification-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    let commands;
    try {
      commands = JSON.parse($('verification-json').value || '[]');
    } catch {
      throw new Error('INVALID_VERIFICATION_JSON');
    }
    await api('/api/verification', { projectId: $('verification-project').value, commands });
    notice('本地验证命令已保存。');
    await refresh(true);
  } catch (error) {
    notice(errorText(error));
  }
});
$('verification-project').addEventListener('change', () => {
  const project = snapshot?.projects.find((item) => item.id === $('verification-project').value);
  $('verification-json').value = JSON.stringify(project?.verification || [], null, 2);
});
void refresh();
const timer = setInterval(() => void refresh(), 2000);
addEventListener('pagehide', () => clearInterval(timer));
