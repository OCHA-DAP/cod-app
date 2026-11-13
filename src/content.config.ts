import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  about: defineCollection({
    loader: glob({ base: "./src/content/about", pattern: "*.mdx" }),
    schema: z.object({ title: z.string(), summary: z.string(), order: z.number() }),
  }),
  standards: defineCollection({
    loader: glob({ base: "./src/content/standards", pattern: "**/*.{md,mdx}" }),
    schema: z.object({
      title: z.string(),
      summary: z.string(),
      order: z.number(),
      variant: z.enum(["wide"]).optional(),
    }),
  }),
};
