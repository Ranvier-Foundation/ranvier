import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Runs a React hook for real (renders, effects, state updates) without a DOM library: the
 * workspace has no jsdom or testing library and adds none. The component renders `null`, so React
 * only needs a container that answers the few calls it makes when a root is created and committed.
 * Every render's result is kept, so a test can also look at the render in between two effects.
 */
export interface HookRun<Props, Result> {
  /** What the hook returned on every render, in order, with the props that render got. */
  renders: { props: Props; result: Result }[];
  readonly latest: Result;
  rerender: (props: Props) => Promise<void>;
  unmount: () => Promise<void>;
}

type Env = { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };

const DOCUMENT = {
  nodeType: 9,
  activeElement: null,
  defaultView: null,
  addEventListener() {},
  removeEventListener() {},
};
const CONTAINER = {
  nodeType: 1,
  nodeName: 'DIV',
  tagName: 'DIV',
  namespaceURI: 'http://www.w3.org/1999/xhtml',
  ownerDocument: DOCUMENT,
  addEventListener() {},
  removeEventListener() {},
};

let installed = 0;
let before: { window: unknown; act: boolean | undefined } | undefined;

/** Installs the little React DOM reads from `window`; undone by the last `restore`. */
function install(): () => void {
  const g = globalThis as Record<string, unknown> & Env;
  if (installed++ === 0) {
    before = { window: g['window'], act: g.IS_REACT_ACT_ENVIRONMENT };
    g['window'] = { event: undefined, HTMLIFrameElement: function HTMLIFrameElement() {} };
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
  return () => {
    if (--installed > 0 || !before) return;
    if (before.window === undefined) delete g['window'];
    else g['window'] = before.window;
    g.IS_REACT_ACT_ENVIRONMENT = before.act;
    before = undefined;
  };
}

export async function renderHook<Props, Result>(
  hook: (props: Props) => Result,
  initial: Props,
): Promise<HookRun<Props, Result>> {
  const restore = install();
  const renders: HookRun<Props, Result>['renders'] = [];
  function Probe({ props }: { props: Props }): ReactNode {
    renders.push({ props, result: hook(props) });
    return null;
  }
  const root = createRoot(CONTAINER as unknown as Element);
  await act(async () => root.render(<Probe props={initial} />));
  return {
    renders,
    get latest() {
      const last = renders[renders.length - 1];
      if (!last) throw new Error('the hook has not rendered');
      return last.result;
    },
    rerender: (props) => act(async () => root.render(<Probe props={props} />)),
    unmount: async () => {
      await act(async () => root.unmount());
      restore();
    },
  };
}
