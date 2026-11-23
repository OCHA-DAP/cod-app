import schema from "$lib/standards/schema.json";

export const GET = () =>
  new Response(JSON.stringify(schema, null, 2) + "\n", {
    headers: { "Content-Type": "application/schema+json" },
  });
