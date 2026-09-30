import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ModelView } from '../../../../protocol/ModelView';
import type { BackendRecord } from '../../backends/types';
import { Coda, Measure, PanelPressable, Rest, Row, Stave } from '../controls';
import { space, type, usePalette } from '../../theme/tokens';

/**
 * A node's installed models and models observed on other paired nodes: the
 * stave and the bare coda of the page. The head (the node's name and how many
 * models it has) belongs to the sheet that opened it.
 */
export function ModelsSheet({
  backend,
  known,
}: {
  backend: BackendRecord | undefined;
  known: readonly ModelView[];
}) {
  const pal = usePalette();
  const [expanded, setExpanded] = useState<string | null>(null);
  const installed = backend?.lastNodeInfo?.models;
  const families = useMemo(() => {
    const models = new Map(known.map(model => [model.selector, model]));
    // This node's declaration wins over another node's version of the model.
    for (const model of installed ?? []) models.set(model.selector, model);
    const groups = new Map<string, ModelView[]>();
    for (const model of [...models.values()].sort((a, b) =>
      a.selector.localeCompare(b.selector),
    )) {
      const group = groups.get(model.family) ?? [];
      group.push(model);
      groups.set(model.family, group);
    }
    return [...groups.entries()];
  }, [installed, known]);

  if (!backend)
    return (
      <>
        <Stave>
          <Measure>
            <Row>
              <Text style={[type.body, { color: pal.muted }]}>
                This node is no longer paired.
              </Text>
            </Row>
          </Measure>
        </Stave>
        <Coda />
      </>
    );
  const name = backend.petname || backend.lastNodeInfo?.name || 'this node';
  return (
    <>
      <Stave keyboardShouldPersistTaps="handled">
        {families.length === 0 ? (
          <Measure>
            <Row>
              <Text style={[type.body, { color: pal.muted }]}>
                No models reported yet.
              </Text>
            </Row>
          </Measure>
        ) : null}
        {families.map(([family, models], familyIndex) => (
          <React.Fragment key={family}>
            {familyIndex === 0 ? null : <Rest />}
            <Measure>
              {models.map((model, index) => {
                const here =
                  installed?.some(entry => entry.selector === model.selector) ??
                  false;
                const open = expanded === model.selector;
                const prefix = `${family}:`;
                const label = model.selector.startsWith(prefix)
                  ? model.selector.slice(prefix.length)
                  : model.selector;
                return (
                  <React.Fragment key={model.selector}>
                    <Row label={index === 0 ? family : undefined}>
                      <PanelPressable
                        accessibilityRole="button"
                        accessibilityLabel={`Model ${model.selector}`}
                        accessibilityState={{ expanded: open }}
                        onPress={() =>
                          setExpanded(open ? null : model.selector)
                        }
                      >
                        <Text style={[type.body, { color: pal.ink }]}>
                          {label}
                        </Text>
                        <Text style={[styles.meta, { color: pal.muted }]}>
                          {here
                            ? 'INSTALLED'
                            : installed
                            ? 'KNOWN ELSEWHERE'
                            : 'INSTALLATION UNKNOWN'}
                        </Text>
                      </PanelPressable>
                      {open ? (
                        <>
                          <Text style={[type.small, { color: pal.muted }]}>
                            {model.stages?.length
                              ? `${
                                  model.stages.length
                                } stages: ${model.stages.join(' → ')}`
                              : 'Stages not declared'}
                          </Text>
                          {here && model.parameters?.length ? (
                            <Text style={[type.small, { color: pal.muted }]}>
                              Controls:{' '}
                              {model.parameters
                                .map(parameter => parameter.label)
                                .join(', ')}
                            </Text>
                          ) : null}
                        </>
                      ) : null}
                    </Row>
                    {open && !here ? (
                      <Row>
                        <View
                          style={[
                            styles.command,
                            { backgroundColor: pal.line },
                          ]}
                        >
                          <Text
                            selectable
                            accessibilityLabel={`Install ${model.selector}`}
                            style={[type.mono, { color: pal.ink }]}
                          >
                            {`cantor pull ${model.selector}`}
                          </Text>
                          <Text style={[type.small, { color: pal.muted }]}>
                            Run on {name}. The node checks availability and
                            requirements.
                          </Text>
                        </View>
                      </Row>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </Measure>
          </React.Fragment>
        ))}
      </Stave>
      <Coda />
    </>
  );
}

const styles = StyleSheet.create({
  meta: { ...type.eyebrow, fontSize: 10, lineHeight: 16, letterSpacing: 0.7 },
  command: { padding: space.sm, gap: space.xs },
});
