import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const demandEvents = sqliteTable("demand_events", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  originArea: text("origin_area").notNull(),
  destinationName: text("destination_name").notNull(),
  category: text("category").notNull(),
  requestedDate: text("requested_date").notNull(),
  hourBucket: integer("hour_bucket").notNull(),
  outcome: text("outcome").notNull(),
  reason: text("reason").notNull(),
  journeyType: text("journey_type").notNull().default("unknown"),
}, (table) => [
  index("demand_created_at_idx").on(table.createdAt),
  index("demand_area_time_idx").on(table.originArea, table.hourBucket),
  index("demand_category_outcome_idx").on(table.category, table.outcome),
]);
