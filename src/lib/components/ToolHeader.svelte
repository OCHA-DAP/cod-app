<script lang="ts">
  import type { Snippet } from "svelte";
  import { toolsBase } from "$lib/utils/paths";
  import Arrow from "./Arrow.svelte";
  import DemoLink from "./DemoLink.svelte";

  let {
    title,
    demo,
    back = { href: `${toolsBase}app/`, label: "All tools" },
    hint,
    children,
  }: {
    title: string;
    demo?: string;
    back?: { href: string; label: string };
    hint?: string;
    children?: Snippet;
  } = $props();
</script>

<header class="tool-header">
  <a class="back" href={back.href}>
    <Arrow dir="back" />
    {back.label}
  </a>
  <h1>{title}</h1>
  {#if demo}<DemoLink slug={demo} />{/if}
  {#if children}<p class="blurb">{@render children()}</p>{/if}
  {#if hint}<p class="hint">{hint}</p>{/if}
</header>

<style>
  .tool-header {
    margin: var(--tool-header-margin, 0);
    padding: 1rem 1rem 1rem 1.375rem;
    border: 1px solid var(--cd-grey--500);
    border-radius: var(--brand-radius);
    background: var(--cd-white);
    box-shadow: inset 6px 0 0 var(--brand-primary--text);
  }

  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin: 0 0 0.4rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--brand-primary--text);
    text-decoration: none;
  }

  .back:hover {
    color: var(--brand-primary--dark);
    text-decoration: underline;
  }

  h1 {
    margin: 0 0 0.5rem;
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--brand-primary--text);
  }

  .blurb {
    margin: 0;
    font-size: 0.825rem;
    line-height: 1.5;
    color: var(--cd-grey--800);
  }

  .hint {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
    line-height: 1.4;
    color: var(--cd-grey--800);
  }
</style>
