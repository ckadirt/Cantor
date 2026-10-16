import type { ErrorWords } from '../core/protocol';
import { createStore } from '../core/store';

export type Notice = Readonly<{
  key: string;
  tone: 'refusal' | 'unreachable' | 'info';
  words: ErrorWords;
  action?: Readonly<{ label: string; run: () => void }>;
}>;

/** KNOBS — time to read a notice, counted only while the hint seat is available. */
export const NOTICE_KNOBS = { STANDS_MS: 6000 } as const;

export function createNotices(initiallyAvailable = true) {
  const store = createStore<readonly Notice[]>([]);
  let available = initiallyAvailable;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const newest = () => store.get()[0] ?? null;
  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    cancelTimer();
    const notice = newest();
    if (available && notice !== null && notice.action === undefined) {
      timer = setTimeout(() => clear(notice.key), NOTICE_KNOBS.STANDS_MS);
    }
  };
  const clear = (key: string) => {
    const before = newest();
    store.set(current =>
      current.some(notice => notice.key === key)
        ? current.filter(notice => notice.key !== key)
        : current,
    );
    if (before !== newest()) schedule();
  };
  return {
    store,
    post: (notice: Notice) => {
      store.set(current => [
        notice,
        ...current.filter(item => item.key !== notice.key),
      ]);
      schedule();
    },
    clear,
    /** Hidden by the player: keep notices until the foot can say them. */
    setAvailable: (next: boolean) => {
      if (next === available) return;
      available = next;
      schedule();
    },
    act: (notice: Notice) => {
      if (notice.action === undefined || newest() !== notice) return;
      try {
        notice.action.run();
      } finally {
        // An action may synchronously post its next answer under the same key.
        if (store.get().includes(notice)) clear(notice.key);
      }
    },
  };
}

// No reading time passes before the field overlay has mounted.
export const notices = createNotices(false);
