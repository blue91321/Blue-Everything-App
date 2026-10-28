/**
 * The one helper the schema files share. Not exported from the package.
 */
import { z } from 'zod';

/**
 * An update schema: every field optional, and **no defaults**.
 *
 * `.partial()` was enough under zod 3. zod 4 applies a field's `.default()`
 * even once `.partial()` has made it optional, so an edit that left a field
 * out came back with the default in it: editing a gauge habit's name sent
 * `mode: 'target'` and turned it into a counted one. Found by `smoke` on the
 * upgrade (zod 3 has a memory-exhaustion advisory fixed only in 4). The type
 * is `.partial()`'s; the runtime drops each default before making it optional.
 */
export function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const typed = schema.partial();
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema.shape as unknown as Record<string, z.ZodTypeAny>)) {
    shape[key] = (field instanceof z.ZodDefault ? (field.unwrap() as z.ZodTypeAny) : field).optional();
  }
  return z.object(shape) as unknown as typeof typed;
}
