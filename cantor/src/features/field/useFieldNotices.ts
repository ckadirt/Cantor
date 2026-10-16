import { useCallback, useEffect, useRef } from 'react';
import type { ErrorWords } from '../../core/protocol';
import type { BackendRuntimeState } from '../../runtime/backendRuntime';
import type { CondensingSubmission } from '../composer/useSubmission';
import { notices } from '../../notices';

const RUNTIME_NOTICE = 'runtime';

/**
 * The failures that outlive the surface where they happened: a refused
 * submission after the composer closed, an audio action, and anything the
 * runtime reports from its background work (loading paired nodes, syncing,
 * sending), which belongs to no sheet at all.
 */
export function useFieldNotices({
  submissionFailure,
  runtimeError,
  failureWords,
  nodeNameOf,
  setCondensing,
}: {
  submissionFailure: BackendRuntimeState['submissionFailure'];
  runtimeError: BackendRuntimeState['storageError'];
  failureWords: (error: unknown, node: string) => ErrorWords;
  nodeNameOf: (key: string) => string;
  setCondensing: (
    update: (
      current: CondensingSubmission | null,
    ) => CondensingSubmission | null,
  ) => void;
}) {
  const seen = useRef<typeof submissionFailure>(null);
  useEffect(() => {
    if (submissionFailure === null || seen.current === submissionFailure)
      return;
    seen.current = submissionFailure;
    setCondensing(current =>
      current?.jobKey === submissionFailure.workKey ? null : current,
    );
    notices.post({
      key: `work:${submissionFailure.workKey}`,
      tone: 'refusal',
      words: failureWords(
        submissionFailure.error,
        nodeNameOf(submissionFailure.nodePublicKey),
      ),
    });
  }, [submissionFailure, failureWords, nodeNameOf, setCondensing]);

  // One notice for the runtime's background work; it stands while the error
  // does, and leaves when the runtime clears it.
  useEffect(() => {
    if (runtimeError === null) {
      notices.clear(RUNTIME_NOTICE);
      return;
    }
    notices.post({
      key: RUNTIME_NOTICE,
      tone: 'info',
      words: failureWords(new Error(runtimeError), 'this phone'),
    });
  }, [runtimeError, failureWords]);

  return useCallback(
    async function runAudio(
      key: string,
      nodePublicKey: string,
      run: () => Promise<void>,
    ): Promise<void> {
      notices.clear(`audio:${key}`);
      try {
        await run();
      } catch (error) {
        const words = failureWords(error, nodeNameOf(nodePublicKey));
        notices.post({
          key: `audio:${key}`,
          tone:
            words.held || words.next === 'again' ? 'unreachable' : 'refusal',
          words,
          action: {
            label: 'TRY AGAIN',
            run: () => runAudio(key, nodePublicKey, run),
          },
        });
      }
    },
    [failureWords, nodeNameOf],
  );
}
