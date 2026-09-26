-- A blank CRM Budget is valid. Commercial fields such as Deal value and
-- Sub-deal value are not planning budgets, so app.briefs must preserve null.
ALTER TABLE app.briefs
  ALTER COLUMN budget DROP NOT NULL;
