import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * Prototype state: an in-memory song store plus a fake generation engine
 * that walks songs through the same states the real GGML pipeline will.
 * Interruption is a normal state here on purpose — the real engine gets
 * killed by the OS and resumes from a stage checkpoint.
 */

export type SongState =
  | 'queued'
  | 'generating'
  | 'interrupted'
  | 'done'
  | 'failed'
  | 'cancelled';

export type Stage = 'reading lyrics' | 'composing structure' | 'denoising' | 'decoding audio';

export type Song = {
  id: string;
  title: string;
  tags: string;
  lyrics: string;
  durationSec: number;
  seed: number;
  state: SongState;
  stage: Stage;
  /** 0..1 overall progress */
  progress: number;
  /** denoising step counter, e.g. "23/60" */
  step?: string;
  createdAt: number;
};

type Store = {
  identity: string[] | null;
  setIdentity: (words: string[]) => void;
  songs: Song[];
  createSong: (draft: Pick<Song, 'title' | 'tags' | 'lyrics' | 'durationSec'>) => Song;
  cancelSong: (id: string) => void;
  resumeSong: (id: string) => void;
  deleteSong: (id: string) => void;
};

const Ctx = createContext<Store | null>(null);

const TOTAL_STEPS = 60;
// stage boundaries as fractions of overall progress
const STAGES: Array<{ stage: Stage; until: number }> = [
  { stage: 'reading lyrics', until: 0.08 },
  { stage: 'composing structure', until: 0.18 },
  { stage: 'denoising', until: 0.85 },
  { stage: 'decoding audio', until: 1.0 },
];

function stageFor(progress: number): Stage {
  return STAGES.find(s => progress < s.until)?.stage ?? 'decoding audio';
}

export function SongsProvider({ children }: { children: React.ReactNode }) {
  const [identity, setIdentityState] = useState<string[] | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fake engine: one ticker advances whichever song is generating.
  useEffect(() => {
    timer.current = setInterval(() => {
      setSongs(prev => {
        if (!prev.some(s => s.state === 'generating')) {
          return prev;
        }
        return prev.map(s => {
          if (s.state !== 'generating') {
            return s;
          }
          const progress = Math.min(1, s.progress + 0.004 + Math.random() * 0.004);
          const stage = stageFor(progress);
          const step =
            stage === 'denoising'
              ? `${Math.min(TOTAL_STEPS, Math.round(((progress - 0.18) / 0.67) * TOTAL_STEPS))}/${TOTAL_STEPS}`
              : undefined;
          if (progress >= 1) {
            return { ...s, state: 'done' as const, progress: 1, step: undefined };
          }
          return { ...s, progress, stage, step };
        });
      });
    }, 250);
    return () => {
      if (timer.current) {
        clearInterval(timer.current);
      }
    };
  }, []);

  const setIdentity = useCallback((words: string[]) => setIdentityState(words), []);

  const createSong = useCallback<Store['createSong']>(draft => {
    const song: Song = {
      ...draft,
      id: Math.random().toString(36).slice(2, 10),
      seed: Math.floor(Math.random() * 2 ** 31),
      state: 'generating',
      stage: 'reading lyrics',
      progress: 0,
      createdAt: Date.now(),
    };
    setSongs(prev => [song, ...prev]);
    return song;
  }, []);

  const patch = (id: string, p: Partial<Song>) =>
    setSongs(prev => prev.map(s => (s.id === id ? { ...s, ...p } : s)));

  const cancelSong = useCallback((id: string) => patch(id, { state: 'cancelled' }), []);
  const resumeSong = useCallback((id: string) => patch(id, { state: 'generating' }), []);
  const deleteSong = useCallback(
    (id: string) => setSongs(prev => prev.filter(s => s.id !== id)),
    [],
  );

  const value = useMemo(
    () => ({ identity, setIdentity, songs, createSong, cancelSong, resumeSong, deleteSong }),
    [identity, setIdentity, songs, createSong, cancelSong, resumeSong, deleteSong],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSongs(): Store {
  const store = useContext(Ctx);
  if (!store) {
    throw new Error('useSongs must be used inside SongsProvider');
  }
  return store;
}
