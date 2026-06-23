const MODULE_ID = "critical-hits-and-fumbles-pf1";
const TABLE_PACK = `${MODULE_ID}.critrolls`;

const CRIT_TABLES = {
  bludgeoning: "Critical Hit - Bludgeoning",
  piercing: "Critical Hit - Piercing",
  slashing: "Critical Hit - Slashing",
  magic: "Critical Hit - Magic"
};

const FUMBLE_TABLES = {
  melee: "Critical Fumbles - Melee",
  ranged: "Critical Fumbles - Ranged",
  magic: "Critical Fumbles - Magic",
  natural: "Critical Fumbles - Natural"
};

const processedMessages = new Set();

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "autoRollEnabled", {
    name: "Auto-roll critical hit and fumble tables",
    hint: "Automatically rolls a critical hit table after PF1 reports a confirmed critical hit, or a fumble table when an attack roll produces a natural 1.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "critFallbackTable", {
    name: "Fallback critical hit table",
    hint: "Used when the attack's damage type cannot be detected.",
    scope: "world",
    config: true,
    type: String,
    choices: toChoices(CRIT_TABLES),
    default: CRIT_TABLES.slashing
  });

  game.settings.register(MODULE_ID, "fumbleFallbackTable", {
    name: "Fallback fumble table",
    hint: "Used when the attack type cannot be detected.",
    scope: "world",
    config: true,
    type: String,
    choices: toChoices(FUMBLE_TABLES),
    default: FUMBLE_TABLES.melee
  });
});

Hooks.once("ready", () => {
  if (game.system?.id !== "pf1") return;

  Hooks.on("createChatMessage", (message) => {
    if (!game.settings.get(MODULE_ID, "autoRollEnabled")) return;
    if (!isPrimaryActiveGM()) return;
    if (!message?.id || processedMessages.has(message.id)) return;

    processedMessages.add(message.id);
    void handleChatMessage(message);
  });
});

async function handleChatMessage(message) {
  try {
    const rolls = getMessageRolls(message);
    const d20Results = getD20Results(rolls);
    if (!d20Results.length) return;

    const searchText = buildSearchText(message, rolls);
    if (!isAttackRoll(searchText)) return;

    const natural1 = d20Results.includes(1);
    const confirmedCritical = isConfirmedCritical(searchText);
    const fumbleText = /\bfumble\b|\bnatural\s+1\b|\bnat(?:ural)?\s+one\b/i.test(searchText);

    if (confirmedCritical) {
      await drawNamedTable(selectCriticalTable(searchText));
    }

    if ((natural1 || fumbleText) && !isCriticalConfirmationRoll(searchText)) {
      await drawNamedTable(selectFumbleTable(searchText));
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to auto-roll a critical table`, error);
  }
}

function getMessageRolls(message) {
  if (Array.isArray(message.rolls)) return message.rolls;

  const sourceRolls = foundry.utils.getProperty(message, "_source.rolls");
  if (Array.isArray(sourceRolls)) return sourceRolls;

  const roll = message.roll;
  return roll ? [roll] : [];
}

function getD20Results(rolls) {
  return rolls.flatMap((roll) => {
    const dice = collectDiceTerms(roll).filter((die) => Number(die.faces) === 20);
    return dice.flatMap(getActiveDieResults);
  });
}

function collectDiceTerms(roll) {
  const terms = new Set(roll?.dice ?? []);

  const visit = (term) => {
    if (!term || typeof term !== "object") return;
    if (Number(term.faces) > 0 && Array.isArray(term.results)) terms.add(term);

    for (const child of term.terms ?? []) visit(child);
    for (const child of term.rolls ?? []) visit(child);
  };

  for (const term of roll?.terms ?? []) visit(term);
  return [...terms];
}

function getActiveDieResults(die) {
  const rawResults = (die.results ?? [])
    .map((result) => ({
      value: Number(result.result),
      active: result.active !== false && result.discarded !== true && result.rerolled !== true
    }))
    .filter((result) => Number.isFinite(result.value));

  const activeResults = rawResults.filter((result) => result.active);
  return (activeResults.length ? activeResults : rawResults).map((result) => result.value);
}

function buildSearchText(message, rolls) {
  const parts = [
    message.flavor,
    message.content,
    message.alias,
    message.speaker?.alias,
    message.speakerActor?.name,
    ...collectStrings(message.flags),
    ...rolls.flatMap((roll) => [
      roll.formula,
      ...collectStrings(roll.options)
    ])
  ];

  return parts
    .filter((part) => typeof part === "string" && part.length)
    .join(" ")
    .replace(/<[^>]*>/g, " ")
    .toLowerCase();
}

function collectStrings(value, depth = 0, seen = new Set()) {
  if (depth > 5 || value == null) return [];
  if (typeof value === "string") return [value];
  if (typeof value !== "object") return [];
  if (seen.has(value)) return [];

  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStrings(entry, depth + 1, seen));
  }

  return Object.entries(value).flatMap(([key, entry]) => [
    key,
    ...collectStrings(entry, depth + 1, seen)
  ]);
}

function isAttackRoll(searchText) {
  if (/\b(init|initiative|skill|saving throw|savingthrow|ability check)\b/i.test(searchText)) {
    return false;
  }

  return /\battack\b|attack-roll|attackroll|\batk\b|mwak|rwak|mattack|rattack|\bconfirm(?:ed|ing|ation)?\b|\bcritical\s+(hit|threat)\b|\bfumble\b/i.test(searchText);
}

function isConfirmedCritical(searchText) {
  if (isFailedCriticalConfirmation(searchText) || isCriticalThreat(searchText)) return false;

  return /\bconfirmed\s+critical\b|\bcritical\s+confirmed\b|\bcritical\s+hit\b|\bcritical\s+success\b/i.test(searchText);
}

function isCriticalThreat(searchText) {
  return /\bcritical\s+threat\b|\bthreatens?\s+(?:a\s+)?critical\b|\bthreat\s+range\b/i.test(searchText);
}

function isFailedCriticalConfirmation(searchText) {
  return /\bunconfirmed\b|\bnot\s+confirmed\b|\bfailed\s+to\s+confirm\b|\bconfirmation\s+failed\b|\bcritical\s+confirmation\s+miss(?:ed)?\b/i.test(searchText);
}

function isCriticalConfirmationRoll(searchText) {
  return /\bconfirm(?:ed|ing|ation)?\b|\bconfirming\s+critical\b|\bcritical\s+confirm\b/i.test(searchText);
}

function selectCriticalTable(searchText) {
  if (/\bspell\b|\bmagic\b|caster|ray\b|touch attack|energy damage/i.test(searchText)) return CRIT_TABLES.magic;
  if (/\bbludgeoning\b|\bbludgeon\b|\bblunt\b/i.test(searchText)) return CRIT_TABLES.bludgeoning;
  if (/\bpiercing\b|\bpierce\b/i.test(searchText)) return CRIT_TABLES.piercing;
  if (/\bslashing\b|\bslash\b/i.test(searchText)) return CRIT_TABLES.slashing;

  return game.settings.get(MODULE_ID, "critFallbackTable");
}

function selectFumbleTable(searchText) {
  if (/\bspell\b|\bmagic\b|caster|ray\b|touch attack/i.test(searchText)) return FUMBLE_TABLES.magic;
  if (/\bnatural attack\b|\bclaw\b|\bbite\b|\bgore\b|\bslam\b|\btalon\b|\bhoof\b|\btentacle\b/i.test(searchText)) return FUMBLE_TABLES.natural;
  if (/\branged\b|\bbow\b|\bcrossbow\b|\bthrown\b|\bfirearm\b|\bprojectile\b/i.test(searchText)) return FUMBLE_TABLES.ranged;
  if (/\bmelee\b|\bmwak\b|\bweapon\b/i.test(searchText)) return FUMBLE_TABLES.melee;

  return game.settings.get(MODULE_ID, "fumbleFallbackTable");
}

async function drawNamedTable(tableName) {
  const pack = game.packs.get(TABLE_PACK);
  if (!pack) {
    ui.notifications?.warn("Critical Hits and Fumbles for PF1 could not find its roll table compendium.");
    return;
  }

  const index = await pack.getIndex({ fields: ["name"] });
  const entry = Array.from(index.values()).find((item) => item.name === tableName);

  if (!entry) {
    ui.notifications?.warn(`Critical Hits and Fumbles for PF1 could not find "${tableName}".`);
    return;
  }

  const table = await pack.getDocument(entry._id);
  await table.draw({ displayChat: true });
}

function isPrimaryActiveGM() {
  if (!game.user?.isGM) return false;

  const users = Array.isArray(game.users?.contents)
    ? game.users.contents
    : Array.from(game.users?.values?.() ?? []);

  const activeGMs = users
    .filter((user) => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id));

  return activeGMs[0]?.id === game.user.id;
}

function toChoices(tables) {
  return Object.fromEntries(Object.values(tables).map((tableName) => [tableName, tableName]));
}
