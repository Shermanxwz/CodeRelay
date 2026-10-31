import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';

const clientRoot = new URL('../plugins/minimax-coderelay/miniapp/client/', import.meta.url);
const [html, script] = await Promise.all([
  readFile(new URL('index.html', clientRoot), 'utf8'),
  readFile(new URL('app.js', clientRoot), 'utf8'),
]);
interface Project {
  id: string;
  name: string;
  workspaceDir: string;
  sessionId: string;
  verification: unknown[];
}
interface Question {
  sessionId: string;
  requestId: string;
  request: {
    title: string;
    steps: {
      id: string;
      question: string;
      selectionMode: string;
      allowOther: boolean;
      options: { id: string; label: string }[];
    }[];
  };
}
interface Job {
  id: string;
  projectName: string;
  sessionId: string;
  phase: string;
  outcome: string | null;
  error: string | null;
  reconciled: boolean;
  answering: boolean;
  nextSequence: number;
  result: { summary: string } | null;
  permissions: { sessionId: string; requestId: string; toolName: string; reason: string }[];
  question: Question | null;
}
interface Snapshot {
  enabled: boolean;
  lastError: string | null;
  connection: { gatewayUrl: string; device: { name: string } } | null;
  projects: Project[];
  jobs: Job[];
}
type Body = Record<string, unknown>;
type Handler = (body: Body) => Promise<unknown>;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean, label = 'DOM update') {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
function job(): Job {
  return {
    id: 'task_fixture',
    projectName: '示例项目',
    sessionId: 'owned_session',
    phase: 'waiting_input',
    outcome: null,
    error: null,
    reconciled: false,
    answering: false,
    nextSequence: 2,
    result: null,
    permissions: [],
    question: null,
  };
}
function questionnaire(): Question {
  return {
    sessionId: 'owned_session',
    requestId: 'question_fixture',
    request: {
      title: '实现前需要你的选择',
      steps: [
        {
          id: 'framework',
          question: '选择框架',
          selectionMode: 'single',
          allowOther: false,
          options: [{ id: 'node', label: 'Node.js' }],
        },
        {
          id: 'details',
          question: '补充验收要求',
          selectionMode: 'single',
          allowOther: true,
          options: [{ id: 'default', label: '使用默认要求' }],
        },
      ],
    },
  };
}
function paired(): Partial<Snapshot> {
  return {
    connection: { gatewayUrl: 'https://relay.example.invalid', device: { name: '合成桌面设备' } },
    projects: [
      {
        id: 'project_fixture',
        name: '示例项目',
        workspaceDir: '/synthetic/project',
        sessionId: 'owned_session',
        verification: [],
      },
    ],
  };
}

async function fixture(initial: Partial<Snapshot> = {}, hasHost = true) {
  const window = parseHTML(html);
  const document = window.document;
  // LinkeDOM does not implement layout, native focus tracking, radio-group
  // default actions or the browser's writable select.value. These small shims
  // support event/DOM assertions only; this suite makes no pixel-layout claim.
  let focused: Element | null = document.body;
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => focused });
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  window.HTMLTextAreaElement.prototype.setSelectionRange = function (start, end) {
    this.selectionStart = start ?? 0;
    this.selectionEnd = end ?? 0;
  };
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() {
      return (
        this.querySelector('option[selected]')?.value ?? this.querySelector('option')?.value ?? ''
      );
    },
    set(value: string) {
      for (const option of this.querySelectorAll('option')) {
        if (option.value === value) option.setAttribute('selected', '');
        else option.removeAttribute('selected');
      }
    },
  });
  const state: Snapshot = {
    enabled: false,
    lastError: null,
    connection: null,
    projects: [],
    jobs: [],
    ...structuredClone(initial),
  };
  const requests: { path: string; body: Body }[] = [];
  const hostCalls = { create: 0, open: [] as string[] };
  let createGate: Promise<void> = Promise.resolve();
  const handlers = new Map<string, Handler>();
  if (hasHost)
    Object.assign(window, {
      mcode: {
        miniapp: {
          agent: {
            async create() {
              hostCalls.create++;
              await createGate;
              return { sessionId: 'owned_created_session' };
            },
            async open(sessionId: string) {
              hostCalls.open.push(sessionId);
            },
          },
        },
      },
    });
  const context = createContext({
    window,
    document,
    console,
    setInterval: () => 1,
    clearInterval() {},
    addEventListener: window.addEventListener.bind(window),
    async fetch(path: string, options: { body?: string } = {}) {
      const body = JSON.parse(options.body ?? '{}') as Body;
      if (path !== '/api/status') requests.push({ path, body });
      try {
        let result: unknown;
        if (handlers.has(path)) result = await handlers.get(path)!(body);
        else if (path === '/api/status') result = structuredClone(state);
        else if (path === '/api/pair') {
          state.connection = {
            gatewayUrl: String(body.gatewayUrl),
            device: { name: String(body.name) },
          };
          result = { paired: true };
        } else if (path === '/api/projects/bind') {
          const project = {
            id: 'project_fixture',
            name: String(body.name),
            workspaceDir: '/synthetic/project',
            sessionId: String(body.sessionId),
            verification: [],
          };
          state.projects = [project];
          result = { project };
        } else if (path === '/api/connect') {
          state.enabled = true;
          result = { enabled: true };
        } else if (path === '/api/pause') {
          state.enabled = false;
          result = { enabled: false };
        } else result = {};
        return {
          ok: true,
          async json() {
            return result;
          },
        };
      } catch (error) {
        return {
          ok: false,
          async json() {
            return { error: { code: (error as { code: string }).code } };
          },
        };
      }
    },
  });
  runInContext(script, context, { filename: 'production-miniapp-app.js' });
  const refresh = async () => {
    await until(() => !runInContext('refreshBusy', context));
    await runInContext('refresh(true)', context);
  };
  await refresh();
  function element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const value = document.querySelector<T>(selector);
    assert.ok(value, `Missing ${selector}`);
    return value;
  }
  function button(label: string): HTMLButtonElement {
    const value = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === label,
    );
    assert.ok(value, `Missing button ${label}`);
    return value;
  }
  function event(target: Element, type: string) {
    target.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  }
  function input(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
    target.value = value;
    event(target, 'input');
  }
  function check(target: HTMLInputElement, checked = true) {
    if (target.type === 'radio' && checked)
      for (const other of document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
        if (other.name === target.name) other.checked = false;
    target.checked = checked;
    event(target, 'input');
    event(target, 'change');
  }
  return {
    window,
    document,
    state,
    requests,
    handlers,
    hostCalls,
    refresh,
    element,
    button,
    event,
    input,
    check,
    gateCreate(promise: Promise<void>) {
      createGate = promise;
    },
  };
}

test('Chinese Mini App DOM: missing desktop Host disables execution and states unverified live acceptance', async () => {
  const f = await fixture({}, false);
  assert.equal(f.element('#host-missing').hidden, false);
  assert.equal(f.element<HTMLButtonElement>('#bind').disabled, true);
  assert.equal(f.element<HTMLButtonElement>('#connect').disabled, true);
  assert.equal(f.element('#pair-form').hidden, false);
  assert.match(f.element('footer').textContent!, /实机验收待完成/);
  assert.equal(f.requests.length, 0);
});

test('Chinese Mini App DOM: pairing clears one-time code and binding cannot repeat while Host creation is pending', async () => {
  const f = await fixture();
  f.input(f.element('#gateway-url'), 'https://relay.example.invalid');
  f.input(f.element('#device-name'), '合成测试设备');
  f.input(f.element('#pairing-code'), 'one-use-fixture');
  f.event(f.element('#pair-form'), 'submit');
  await until(() => Boolean(f.element('#pair-form').hidden));
  assert.equal(f.element<HTMLInputElement>('#pairing-code').value, '');
  assert.equal(f.requests[0]?.body.code, 'one-use-fixture');
  const gate = deferred();
  f.gateCreate(gate.promise);
  f.input(f.element('#project-name'), '本地界面验证仓库');
  f.event(f.element('#bind'), 'click');
  await until(() => f.hostCalls.create === 1);
  await f.refresh();
  assert.equal(f.element<HTMLButtonElement>('#bind').disabled, true);
  f.event(f.element('#bind'), 'click');
  assert.equal(
    f.hostCalls.create,
    1,
    'even a programmatic duplicate cannot create another session',
  );
  gate.resolve();
  await until(() => f.element('#projects').textContent!.includes('本地界面验证仓库'));
  assert.equal(f.requests.filter((request) => request.path === '/api/projects/bind').length, 1);
  assert.equal(
    f.requests.find((request) => request.path === '/api/projects/bind')?.body.sessionId,
    'owned_created_session',
  );
  f.event(f.button('打开工作会话'), 'click');
  await until(() => f.hostCalls.open.length === 1);
  assert.equal(f.hostCalls.open[0], 'owned_created_session');
  f.event(f.element('#connect'), 'click');
  await until(() => f.element('#connection-state').textContent === '接单中');
  f.event(f.element('#pause'), 'click');
  await until(() => f.element('#connection-state').textContent === '已配对 · 暂停接单');
});

test('Chinese Mini App DOM: both child approval buttons stay locked through refresh and submit once', async () => {
  const active = job();
  active.permissions = [
    {
      sessionId: 'child_session',
      requestId: 'permission_fixture',
      toolName: 'shell',
      reason: '运行合成测试',
    },
  ];
  const f = await fixture({ ...paired(), jobs: [active] });
  const gate = deferred();
  f.handlers.set('/api/command', async () => {
    await gate.promise;
    f.state.jobs[0]!.permissions = [];
    return { status: 'applied' };
  });
  f.event(f.button('仅允许本次'), 'click');
  await until(() => f.requests.length === 1);
  assert.equal(f.button('拒绝').disabled, true);
  f.state.jobs[0]!.nextSequence = 22;
  await f.refresh();
  assert.equal(f.button('拒绝').disabled, true);
  assert.equal(f.button('仅允许本次').disabled, true);
  f.event(f.button('拒绝'), 'click');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0]!.body, {
    taskId: 'task_fixture',
    kind: 'reply',
    payload: { sessionId: 'child_session', requestId: 'permission_fixture', decision: 'allowOnce' },
  });
  gate.resolve();
  await until(() => !f.element('#jobs').textContent!.includes('仅允许本次'));
});

test('Chinese Mini App DOM: questionnaire respects allowOther, preserves drafts and sends exact step selections once', async () => {
  const active = job();
  active.question = questionnaire();
  const f = await fixture({ ...paired(), jobs: [active] });
  const fields = f.document.querySelectorAll('fieldset');
  assert.equal(fields[0]!.querySelectorAll('textarea').length, 0);
  assert.equal(fields[1]!.querySelectorAll('textarea').length, 1);
  f.check(fields[0]!.querySelector<HTMLInputElement>('input[type="radio"]')!);
  const otherChoice = [...fields[1]!.querySelectorAll('label')]
    .find((label) => label.textContent === '其他回答')!
    .querySelector('input')!;
  f.check(otherChoice);
  const draft = f.element<HTMLTextAreaElement>('#jobs textarea');
  f.input(draft, '请验证中文输出');
  draft.focus();
  draft.setSelectionRange(3, 3);
  f.state.jobs[0]!.nextSequence = 22;
  await f.refresh();
  assert.equal(f.element<HTMLTextAreaElement>('#jobs textarea').value, '请验证中文输出');
  assert.equal(f.document.activeElement?.id, draft.id);
  assert.equal(f.element<HTMLTextAreaElement>('#jobs textarea').selectionStart, 3);
  const gate = deferred();
  f.handlers.set('/api/command', async () => {
    f.state.jobs[0]!.answering = true;
    await gate.promise;
    Object.assign(f.state.jobs[0]!, {
      answering: false,
      question: null,
      phase: 'terminal',
      outcome: 'succeeded',
      result: { summary: '合成 UI 测试完成' },
    });
    return { status: 'applied' };
  });
  f.event(f.element('form.approval'), 'submit');
  await until(() => f.requests.length === 1);
  await f.refresh();
  assert.equal(f.button('正在继续执行…').disabled, true);
  f.event(f.element('form.approval'), 'submit');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0]!.body, {
    taskId: 'task_fixture',
    kind: 'answer',
    payload: {
      sessionId: 'owned_session',
      requestId: 'question_fixture',
      answers: [
        { stepId: 'framework', selectedOptionIds: ['node'], selectedOther: false },
        {
          stepId: 'details',
          selectedOptionIds: [],
          selectedOther: true,
          otherText: '请验证中文输出',
        },
      ],
    },
  });
  gate.resolve();
  await until(() => f.element('#jobs').textContent!.includes('已完成'));
  assert.equal(f.document.querySelector('form.approval'), null);
});

test('Chinese Mini App DOM: explicit skip is supported and missing answers never leave the page', async () => {
  const active = job();
  active.question = questionnaire();
  active.question.request.steps = [active.question.request.steps[0]!];
  const f = await fixture({ ...paired(), jobs: [active] });
  f.event(f.element('form.approval'), 'submit');
  await until(() => f.element('#notice').textContent!.includes('请选择答案'));
  assert.equal(f.requests.length, 0);
  f.check(f.element('label.skip input'));
  assert.equal(f.element<HTMLInputElement>('fieldset input[type="radio"]').disabled, true);
  f.event(f.element('form.approval'), 'submit');
  await until(() => f.requests.length === 1);
  assert.deepEqual((f.requests[0]!.body.payload as { answers: unknown[] }).answers, [
    { stepId: 'framework', selectedOptionIds: [], selectedOther: false, skipped: true },
  ]);
});

test('Chinese Mini App DOM: unknown outcome replaces a focused form and only explicit reconciliation clears its action', async () => {
  const active = job();
  active.question = questionnaire();
  const f = await fixture({ ...paired(), jobs: [active] });
  f.element<HTMLTextAreaElement>('#jobs textarea').focus();
  Object.assign(f.state.jobs[0]!, {
    outcome: 'unknown',
    phase: 'terminal',
    error: 'PLUGIN_STOPPED_DURING_TASK',
  });
  await f.refresh();
  assert.equal(f.document.querySelector('form.approval'), null);
  assert.match(f.element('#jobs').textContent!, /结果待核对/);
  assert.match(f.element('#jobs').textContent!, /不会重新执行/);
  f.handlers.set('/api/reconcile-status', async () => {
    throw Object.assign(new Error(), { code: 'ADMIN_RECONCILIATION_REQUIRED' });
  });
  f.event(f.button('检查管理员处理结果'), 'click');
  await until(() => f.element('#notice').textContent!.includes('管理员核对实际设备'));
  assert.equal(f.state.jobs[0]!.reconciled, false);
  f.handlers.set('/api/reconcile-status', async () => {
    f.state.jobs[0]!.reconciled = true;
    return { reconciled: true };
  });
  f.event(f.button('检查管理员处理结果'), 'click');
  await until(() => f.element('#jobs').textContent!.includes('已核对'));
  assert.equal(
    [...f.document.querySelectorAll('button')].some(
      (button) => button.textContent === '检查管理员处理结果',
    ),
    false,
  );
});

test('Chinese Mini App DOM: remote text renders as text and long fields have explicit narrow-window wrapping rules', async () => {
  const initial = paired();
  initial.projects![0]!.name = '<img src=x onerror="alert(1)">';
  initial.connection!.gatewayUrl = `https://${'long-name-'.repeat(25)}example.invalid`;
  const f = await fixture(initial);
  assert.equal(f.element('#projects').querySelector('img'), null);
  assert.match(f.element('#projects').textContent!, /<img src=x/);
  const css = (await readFile(new URL('style.css', clientRoot), 'utf8')).replace(/\s+/g, '');
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /\.question-step\{[^}]*min-width:0/);
  assert.match(css, /p\{[^}]*overflow-wrap:anywhere/);
  assert.doesNotMatch(css, /font:60013pxinherit/);
});
