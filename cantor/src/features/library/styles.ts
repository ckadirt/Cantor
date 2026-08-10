import { StyleSheet } from 'react-native';
import { space, touch } from '../../theme/tokens';

export const libraryStyles = StyleSheet.create({
  library: { gap: space.sm },
  librarySearch: {
    borderWidth: 1,
    paddingHorizontal: space.md,
    minHeight: touch.min,
  },
  libraryFilters: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  libraryFilter: { borderWidth: 1, padding: space.sm, minHeight: touch.min },
  noMatches: { paddingVertical: space.sm },
  libraryEmpty: { borderWidth: 1, padding: space.md },
  songCard: { borderWidth: 1, padding: space.md, gap: space.sm },
  songHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  songInput: {
    borderWidth: 1,
    paddingHorizontal: space.sm,
    minHeight: touch.min,
  },
  songActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  songAction: { borderWidth: 1, minHeight: touch.min, padding: space.sm },
  songDetail: { borderTopWidth: 1, paddingTop: space.sm, gap: space.xs },
});
