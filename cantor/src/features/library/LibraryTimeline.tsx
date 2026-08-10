import React, { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { filterLibraryRows, type LibraryFilter } from '../../library/query';
import { type as textType, usePalette } from '../../theme/tokens';
import { LibrarySongRow } from './LibrarySongRow';
import { libraryStyles as styles } from './styles';
import type { LibraryTimelineProps } from './types';

export function LibraryTimeline({
  rows,
  onDetail,
  onPatch,
  onPresence,
  onAudio,
  onError,
}: LibraryTimelineProps) {
  const pal = usePalette();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('active');
  if (rows.length === 0) {
    return (
      <View style={[styles.libraryEmpty, { borderColor: pal.line }]}>
        <Text style={[textType.body, { color: pal.muted }]}>
          Completed songs will appear here without downloading their audio.
        </Text>
      </View>
    );
  }
  const visibleRows = filterLibraryRows(rows, query, filter);
  return (
    <View style={styles.library}>
      <TextInput
        accessibilityLabel="Search private library"
        onChangeText={setQuery}
        placeholder="Search title, caption, tag, or node"
        placeholderTextColor={pal.faint}
        value={query}
        style={[
          styles.librarySearch,
          textType.small,
          { borderColor: pal.line, color: pal.ink },
        ]}
      />
      <View style={styles.libraryFilters}>
        {(
          [
            ['active', 'ALL'],
            ['favorite', 'FAVORITES'],
            ['offline', 'OFFLINE'],
            ['trash', 'TRASH'],
          ] as const
        ).map(([value, label]) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            onPress={() => setFilter(value)}
            style={[
              styles.libraryFilter,
              {
                borderColor: filter === value ? pal.ink : pal.line,
              },
            ]}
          >
            <Text style={[textType.eyebrow, { color: pal.ink }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {visibleRows.length === 0 ? (
        <Text style={[textType.small, styles.noMatches, { color: pal.muted }]}>
          No cached songs match this local view.
        </Text>
      ) : null}
      {visibleRows.map(row => (
        <LibrarySongRow
          key={`${row.backend.nodePubkey}:${row.song.id}`}
          row={row}
          onDetail={onDetail}
          onPatch={onPatch}
          onPresence={onPresence}
          onAudio={onAudio}
          onError={onError}
        />
      ))}
    </View>
  );
}
