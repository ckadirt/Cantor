import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        /** The small line above the title, e.g. "The node · Models". */
        eyebrow: z.string().optional(),
        /**
         * What the page's marks are drawn from. Defaults to the title, so a
         * page keeps its seal unless it is renamed.
         */
        mark: z.string().optional(),
      }),
    }),
  }),
};
