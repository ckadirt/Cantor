import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { JobView } from '../../../../protocol/JobView';
import { readError } from '../../core/errors';
import {
  jobControls,
  jobStateLabel,
  shortKey,
  type JobControl,
} from '../../jobs/policy';
import { space, touch, type, usePalette } from '../../theme/tokens';


export type JobQueueProps = {
  jobs: JobView[];
  online: boolean;
  controlsSupported: boolean;
  onControl: (job: JobView, control: JobControl) => Promise<void>;
};

export function JobQueue({
  jobs,
  online,
  controlsSupported,
  onControl,
}: JobQueueProps) {
  const pal = usePalette();
  const [requesting, setRequesting] = useState<Record<string, JobControl>>({});
  const [controlErrors, setControlErrors] = useState<Record<string, string>>(
    {},
  );
  if (jobs.length === 0) return null;
  const runControl = async (job: JobView, control: JobControl) => {
    setRequesting(current => ({ ...current, [job.id]: control }));
    setControlErrors(current => {
      const next = { ...current };
      delete next[job.id];
      return next;
    });
    try {
      await onControl(job, control);
    } catch (error) {
      setControlErrors(current => ({
        ...current,
        [job.id]: readError(error),
      }));
    } finally {
      setRequesting(current => {
        const next = { ...current };
        delete next[job.id];
        return next;
      });
    }
  };
  return (
    <View style={[styles.queue, { borderColor: pal.line }]}>
      <Text style={[type.eyebrow, { color: pal.faint }]}>QUEUE</Text>
      {jobs.map(job => {
        const total = job.progress?.total;
        const detail =
          total === undefined
            ? job.progress === undefined
              ? null
              : `${job.progress.completed} ${job.progress.unit}`
            : `${job.progress?.completed}/${total} ${job.progress?.unit}`;
        const controls = controlsSupported ? jobControls(job) : [];
        const pending = requesting[job.id];
        return (
          <View key={job.id} style={styles.jobBlock}>
            <View style={styles.jobRow}>
              <View style={styles.jobText}>
                <Text style={[type.small, { color: pal.ink }]}>
                  {pending ? `Requesting ${pending}…` : jobStateLabel(job)}
                </Text>
                <Text style={[type.small, { color: pal.muted }]}>
                  {job.model} · {shortKey(job.id)}
                </Text>
                {job.error ? (
                  <Text style={[type.small, { color: pal.muted }]}>
                    {job.error.message}
                  </Text>
                ) : null}
              </View>
              <Text style={[type.small, { color: pal.faint }]}>
                {detail ?? (!online ? 'offline' : `r${job.revision}`)}
              </Text>
            </View>
            {controls.length > 0 ? (
              <View style={styles.jobActions}>
                {controls.map(control => (
                  <Pressable
                    accessibilityRole="button"
                    disabled={!online || pending !== undefined}
                    key={control}
                    onPress={() => runControl(job, control)}
                    style={[styles.jobAction, { borderColor: pal.line }]}
                  >
                    <Text
                      style={[
                        type.eyebrow,
                        {
                          color:
                            online && pending === undefined
                              ? pal.ink
                              : pal.faint,
                        },
                      ]}
                    >
                      {control.toUpperCase()}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {controlErrors[job.id] ? (
              <Text style={[type.small, { color: pal.muted }]}>
                {controlErrors[job.id]}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  queue: { borderTopWidth: 1, paddingTop: space.sm, gap: space.sm },
  jobRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  jobText: { flex: 1 },
  jobBlock: { gap: space.xs },
  jobActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  jobAction: { borderWidth: 1, minHeight: touch.min, padding: space.sm },
});

// Policy lives in src/jobs/policy.ts so it outlives this screen.
export { jobControls, jobStateLabel, shortKey, type JobControl };
