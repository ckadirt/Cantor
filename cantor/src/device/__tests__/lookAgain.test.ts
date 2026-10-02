import { startLookingAgain, type AppStatePort } from '../lookAgain';

function appState() {
  let listener: ((state: string) => void) | null = null;
  const port: AppStatePort & { emit(state: string): void; removed: boolean } = {
    currentState: 'active',
    removed: false,
    addEventListener: (_type, next) => {
      listener = next;
      return {
        remove: () => {
          port.removed = true;
        },
      };
    },
    emit: state => listener?.(state),
  };
  return port;
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe('startLookingAgain', () => {
  it('looks on open and on each return, debounced', async () => {
    let now = 0;
    const library = {
      refresh: jest.fn(async () => ({ changed: false, folders: [] })),
      checkPermission: jest.fn(async () => 'granted' as const),
    };
    const state = appState();
    const stop = startLookingAgain(library, state, () => now, jest.fn());
    expect(library.refresh).toHaveBeenCalledTimes(1);

    // Back within the debounce: the permission is read, nothing is listed.
    now = 1000;
    state.emit('background');
    state.emit('active');
    await flush();
    expect(library.checkPermission).toHaveBeenCalledTimes(1);
    expect(library.refresh).toHaveBeenCalledTimes(1);

    now = 10_000;
    state.emit('background');
    state.emit('active');
    await flush();
    expect(library.refresh).toHaveBeenCalledTimes(2);

    // Inactive to active (a system dialog) is still a return.
    now = 20_000;
    state.emit('active');
    await flush();
    expect(library.refresh).toHaveBeenCalledTimes(2);

    stop();
    expect(state.removed).toBe(true);
  });
});
