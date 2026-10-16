import { openTestDatabase } from '../../../jest/nodeSqlite';
import { migrate } from '../../core/storage/sql';
import { DEVICE_MIGRATIONS } from '../../device/schema';
import type { SongDetail } from '../../../../protocol/SongDetail';
import { createRecipeRepository, createRecipes } from '../recipes';

const detail: SongDetail = {
  song: {
    id: 'song-1',
    title: 'Lanterns',
    caption_summary: 'a slow harbour',
    duration_ms: 60_000,
    model: 'acestep@1.5-turbo',
    seed: 7,
    favorite: false,
    tags: [],
    created_at: '2026-10-14T00:00:00Z',
    revision: 1,
    trashed: false,
    artifacts: [],
  },
  generation: { caption: 'a slow harbour', lyrics: 'lanterns on the water' },
  engine: 'acestep',
  component_digests: [],
  attempts: 1,
};

async function setup(fetchLive: jest.Mock) {
  const db = openTestDatabase();
  await migrate(db, DEVICE_MIGRATIONS);
  const repository = createRecipeRepository(db);
  const recipes = createRecipes({
    openRepository: async () => repository,
    fetchLive,
    now: () => 1_000,
  });
  return { recipes, repository };
}

const away = () => Promise.reject(new Error('Song node is not connected.'));

describe('kept recipes', () => {
  it('keeps what the node sent and gives it back when the node is away', async () => {
    const fetchLive = jest.fn().mockResolvedValueOnce(detail);
    const { recipes } = await setup(fetchLive);
    await expect(recipes.detail('rtx', 'song-1')).resolves.toEqual(detail);

    fetchLive.mockImplementation(away);
    await expect(recipes.detail('rtx', 'song-1')).resolves.toEqual(detail);
  });

  it('says the node is away when it never kept the recipe', async () => {
    const { recipes } = await setup(jest.fn(away));
    await expect(recipes.detail('rtx', 'song-1')).rejects.toThrow(
      'not connected',
    );
  });

  it('keeps a downloaded song’s recipe once, and asks no more', async () => {
    const fetchLive = jest.fn().mockResolvedValue(detail);
    const { recipes, repository } = await setup(fetchLive);
    await recipes.keep('rtx', 'song-1');
    await Promise.all([
      recipes.keep('rtx', 'song-1'),
      recipes.keep('rtx', 'song-1'),
    ]);
    expect(fetchLive).toHaveBeenCalledTimes(1);
    await expect(repository.get('rtx', 'song-1')).resolves.toEqual(detail);
  });

  it('does not ask again for a recipe a previous session kept', async () => {
    const first = await setup(jest.fn().mockResolvedValue(detail));
    await first.recipes.keep('rtx', 'song-1');
    const fetchLive = jest.fn();
    const later = createRecipes({
      openRepository: async () => first.repository,
      fetchLive,
      now: () => 2_000,
    });
    await later.keep('rtx', 'song-1');
    expect(fetchLive).not.toHaveBeenCalled();
  });

  it('tries again next time when the node could not be asked', async () => {
    const fetchLive = jest
      .fn()
      .mockImplementationOnce(away)
      .mockResolvedValueOnce(detail);
    const { recipes, repository } = await setup(fetchLive);
    await recipes.keep('rtx', 'song-1');
    await expect(repository.get('rtx', 'song-1')).resolves.toBeNull();
    await recipes.keep('rtx', 'song-1');
    await expect(repository.get('rtx', 'song-1')).resolves.toEqual(detail);
  });
});
