import { PGlite } from "@electric-sql/pglite";
import {
  pgliteQueryable,
  postgresDatabase,
} from "../../src/platform/standard/sql/postgres.ts";

/** The test adapter owns its PGlite instance, including shutdown. */
export function createTestPostgresDatabase() {
  const pg = new PGlite();
  return postgresDatabase(pgliteQueryable(pg), () => pg.close());
}
