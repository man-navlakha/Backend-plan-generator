/**
 * Costed plan, or inventory sheet?
 *
 * A brief that states a budget is asking what to buy with it: the engine picks a
 * set, applies minimum billing, adds the making charge and totals it up. A brief
 * with no budget is asking a different question -- what is available and what
 * does it cost -- and the desk answers it with a list. Nothing on that list is
 * bought, so nothing on it is floored to a minimum, charged for a creative or
 * carried into a total.
 *
 * The two are different documents, not one document with a number missing, and
 * every step that has to tell them apart reads it from here.
 */

const COSTED = 'costed';
const INVENTORY = 'inventory';

function explicitInventoryMode(brief) {
  const mode = String(
    brief?.mode ||
    brief?.plan_mode ||
    brief?.selection_mode ||
    brief?.planning_mode ||
    brief?.request_type ||
    ''
  ).toLowerCase();
  return /^(inventory|options|option_list|catalog|availability)$/.test(mode);
}

function planMode(brief) {
  if (explicitInventoryMode(brief)) return INVENTORY;
  return Number(brief?.budget) > 0 ? COSTED : INVENTORY;
}

const isInventory = (brief) => planMode(brief) === INVENTORY;

module.exports = { planMode, isInventory, COSTED, INVENTORY };
