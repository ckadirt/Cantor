import { useLayoutEffect } from 'react';
import { useStore } from '../core/useStore';
import { notices } from './store';

export { createNotices, notices, NOTICE_KNOBS, type Notice } from './store';

/** The overlay alone lends the foot's seat to the newest notice. */
export function useNotices(available: boolean) {
  const notice = useStore(notices.store, current => current[0] ?? null);
  useLayoutEffect(() => {
    notices.setAvailable(available);
    return () => notices.setAvailable(false);
  }, [available]);
  return notice;
}
