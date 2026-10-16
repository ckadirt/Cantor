import { useCallback, useState } from 'react';
import type { ErrorWords } from '../../core/protocol';
import type { BackendRuntimeCommands } from '../../runtime/backendRuntime';

export type CondensingSubmission = Readonly<{
  caption: string;
  jobKey: string | null;
}>;

/** The Make gesture follows the durable submission's own key. */
export function useSubmission({
  submit,
  closeComposer,
  failureWords,
  nodeNameOf,
}: {
  submit: BackendRuntimeCommands['submit'];
  closeComposer: () => void;
  failureWords: (error: unknown, node: string) => ErrorWords;
  nodeNameOf: (key: string) => string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ErrorWords | null>(null);
  const [condensing, setCondensing] = useState<CondensingSubmission | null>(
    null,
  );
  const submitDraft = useCallback(
    async (...args: Parameters<BackendRuntimeCommands['submit']>) => {
      const [nodePublicKey, , generation] = args;
      setSubmitting(true);
      setSubmitError(null);
      setCondensing({ caption: generation.caption, jobKey: null });
      closeComposer();
      try {
        const jobKey = await submit(...args);
        setCondensing(current =>
          current === null ? null : { ...current, jobKey },
        );
      } catch (error) {
        setCondensing(null);
        setSubmitError(failureWords(error, nodeNameOf(nodePublicKey)));
      } finally {
        setSubmitting(false);
      }
    },
    [submit, closeComposer, failureWords, nodeNameOf],
  );
  return {
    submitting,
    submitError,
    setSubmitError,
    condensing,
    setCondensing,
    submitDraft,
  };
}
