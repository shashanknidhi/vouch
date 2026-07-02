import Database from "better-sqlite3";
import { applySchema } from "./schema.js";

const dbPath = process.env.DB_PATH ?? "./vouch.db";
export const db = new Database(dbPath);
applySchema(db);
