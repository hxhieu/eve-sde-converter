import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ProxyAgent } from 'undici';
const AdmZip = require('adm-zip');

function getProxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  return proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

export interface BuildInfo {
  _key: string;
  buildNumber: number;
  releaseDate: string;
}

export async function getLatestBuildNumber(): Promise<number> {
  try {
    const response = await fetch('https://developers.eveonline.com/static-data/tranquility/latest.jsonl', {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
      dispatcher: getProxyAgent() as any
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.text();
    const lines = data.trim().split('\n');
    const json = JSON.parse(lines[0]) as BuildInfo;
    return json.buildNumber;
  } catch (err) {
    throw err;
  }
}

export async function getChangeSummary(buildNumber: number): Promise<string> {
  try {
    const response = await fetch(`https://developers.eveonline.com/static-data/tranquility/changes/${buildNumber}.jsonl`, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
      dispatcher: getProxyAgent() as any
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.text();
    const lines = data.trim().split('\n');
    
    const changes: Record<string, number> = {};
    let releaseDate = '';
    
    for (const line of lines) {
      if (!line.trim()) continue;
      const json = JSON.parse(line);
      
      if (json._key === '_meta') {
        releaseDate = json.releaseDate;
      } else if (json.changed && Array.isArray(json.changed)) {
        changes[json._key] = json.changed.length;
      }
    }
    
    let summary = `**Updated at:** ${releaseDate}\n\n**Changed tables:**\n`;
    
    const sortedChanges = Object.entries(changes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10); // Top 10 tables
    
    for (const [table, count] of sortedChanges) {
      summary += `- \`${table}\`: ${count} items\n`;
    }
    
    const totalTables = Object.keys(changes).length;
    if (totalTables > 10) {
      summary += `- ... and ${totalTables - 10} more tables`;
    }
    
    return summary;
  } catch (err) {
    // If we can't get changes, return empty string
    return '';
  }
}



export async function downloadZip(buildNumber: number, outputPath: string): Promise<void> {
  const url = `https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-${buildNumber}-jsonl.zip`;
  try {
    const response = await fetch(url, {
      dispatcher: getProxyAgent() as any
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(outputPath, Buffer.from(buffer));
  } catch (err) {
    fs.unlink(outputPath, () => {});
    throw err;
  }
}

export function unzipFile(zipPath: string, outputDir: string): void {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(outputDir, true);
}

export function* readJsonl(filePath: string): Generator<any> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      yield JSON.parse(trimmed);
    }
  }
}

// Name cache for celestial objects (stars, planets, moons, belts, stations, stargates)
// that don't have direct names in the JSONL data.
// Populated by buildNameCache() before table processing begins.
let celestialNameCache: Map<number, string> = new Map();

/**
 * Build a name cache for celestial objects in dependency order.
 *
 * Processing order:
 * 1. Solar Systems (have name.en directly)
 * 2. Stars: <solarSystemName>
 * 3. Planets: <orbitName> <celestialIndex as Roman numeral>
 * 4. Moons: <orbitName> - Moon <orbitIndex>
 * 5. Asteroid Belts: <orbitName> - Asteroid Belt <orbitIndex>
 * 6. NPC Corporations & Station Operations (auxiliary data)
 * 7. Stations (useOperationName): <orbitName> - <corporationName> <operationName>
 *    Stations (!useOperationName): <orbitName> - <corporationName>
 * 8. Stargates: Stargate (<destinationSolarSystemName>)
 */
export function buildNameCache(unzippedDir: string): Map<number, string> {
  const cache = new Map<number, string>();

  // Step 1: Solar Systems - have names directly
  const solarSystemsPath = path.join(unzippedDir, 'mapSolarSystems.jsonl');
  if (fs.existsSync(solarSystemsPath)) {
    for (const item of readJsonl(solarSystemsPath)) {
      cache.set(item._key, item.name?.en || '');
    }
  }

  // Step 2: Stars - name = <solarSystemName>
  const starsPath = path.join(unzippedDir, 'mapStars.jsonl');
  if (fs.existsSync(starsPath)) {
    for (const item of readJsonl(starsPath)) {
      const solarSystemName = cache.get(item.solarSystemID) || '';
      cache.set(item._key, solarSystemName);
    }
  }

  // Step 3: Planets - name = <orbitName> <celestialIndex as Roman numeral>
  const planetsPath = path.join(unzippedDir, 'mapPlanets.jsonl');
  if (fs.existsSync(planetsPath)) {
    for (const item of readJsonl(planetsPath)) {
      const orbitName = cache.get(item.orbitID) || '';
      const romanIndex = convertToRoman(item.celestialIndex);
      cache.set(item._key, `${orbitName} ${romanIndex}`);
    }
  }

  // Step 4: Moons - name = <orbitName> - Moon <orbitIndex>
  const moonsPath = path.join(unzippedDir, 'mapMoons.jsonl');
  if (fs.existsSync(moonsPath)) {
    for (const item of readJsonl(moonsPath)) {
      const orbitName = cache.get(item.orbitID) || '';
      cache.set(item._key, `${orbitName} - Moon ${item.orbitIndex}`);
    }
  }

  // Step 5: Asteroid Belts - name = <orbitName> - Asteroid Belt <orbitIndex>
  const beltsPath = path.join(unzippedDir, 'mapAsteroidBelts.jsonl');
  if (fs.existsSync(beltsPath)) {
    for (const item of readJsonl(beltsPath)) {
      const orbitName = cache.get(item.orbitID) || '';
      cache.set(item._key, `${orbitName} - Asteroid Belt ${item.orbitIndex}`);
    }
  }

  // Step 6: Load auxiliary data for station names
  const corpNames = new Map<number, string>();
  const corpsPath = path.join(unzippedDir, 'npcCorporations.jsonl');
  if (fs.existsSync(corpsPath)) {
    for (const item of readJsonl(corpsPath)) {
      corpNames.set(item._key, item.name?.en || '');
    }
  }

  const operationNames = new Map<number, string>();
  const opsPath = path.join(unzippedDir, 'stationOperations.jsonl');
  if (fs.existsSync(opsPath)) {
    for (const item of readJsonl(opsPath)) {
      operationNames.set(item._key, item.operationName?.en || '');
    }
  }

  // Step 7: Stations
  //   useOperationName=true:  <orbitName> - <corporationName> <operationName>
  //   useOperationName=false: <orbitName> - <corporationName>
  const stationsPath = path.join(unzippedDir, 'npcStations.jsonl');
  if (fs.existsSync(stationsPath)) {
    for (const item of readJsonl(stationsPath)) {
      const orbitName = cache.get(item.orbitID) || '';
      const corpName = corpNames.get(item.ownerID) || '';
      if (item.useOperationName) {
        const opName = operationNames.get(item.operationID) || '';
        cache.set(item._key, `${orbitName} - ${corpName} ${opName}`);
      } else {
        cache.set(item._key, `${orbitName} - ${corpName}`);
      }
    }
  }

  // Step 8: Stargates - name = Stargate (<destinationSolarSystemName>)
  const stargatesPath = path.join(unzippedDir, 'mapStargates.jsonl');
  if (fs.existsSync(stargatesPath)) {
    for (const item of readJsonl(stargatesPath)) {
      const destSystemName = cache.get(item.destination?.solarSystemID) || '';
      cache.set(item._key, `Stargate (${destSystemName})`);
    }
  }

  console.log(`Built name cache with ${cache.size} entries`);
  return cache;
}

/** Raw SQL value – serialised to SQL syntax only when writing the dump. */
export type SqlValue = string | number | boolean | null | undefined;

/** Structured representation of a single INSERT row. */
export interface InsertRow {
  table: string;
  columns: string[];
  values: SqlValue[];
}

/** Extract raw (un-escaped) values from a JSONL item according to a mapping. */
function extractRawValues(
  item: any,
  mapping: any,
  fileName: string,
): SqlValue[] {
  return mapping.fields.map(
    (field: string | { name: string; transform: (item: any, subItem?: any, fileName?: string) => any }) => {
      let value: SqlValue;
      if (typeof field === 'string') {
        const fieldName = field;
        if (fieldName === 'agentID' && item._key !== undefined) {
          value = item._key;
        } else if (fieldName === 'typeID' && item._key !== undefined) {
          value = item._key;
        } else {
          value = item[fieldName];
        }
      } else {
        value = field.transform(item, fileName);
      }
      return value ?? null;
    },
  );
}

/** Escape a single value to its SQL literal representation. */
function serializeSqlValue(value: SqlValue): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') {
    return `'${value.replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}'`;
  }
  return value.toString();
}

/**
 * Serialize structured InsertRow objects into batched multi-row INSERT
 * statements. Rows sharing the same table + column list are merged; each
 * batch is capped by `maxContentLength` (bytes) to stay within MySQL's
 * max_allowed_packet limit.
 */
export function serializeInsertRows(
  rows: InsertRow[],
  maxContentLength: number = 500 * 1024,
  maxRowsPerBatch: number = 500,
): string[] {
  if (rows.length === 0) return [];

  // Group rows by "table + columns" signature, preserving insertion order.
  const groups = new Map<string, InsertRow[]>();
  for (const row of rows) {
    const key = `${row.table}\0${row.columns.join('\0')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const result: string[] = [];
  for (const group of groups.values()) {
    const { table, columns } = group[0];
    const colsPart = columns.map(c => `\`${c}\``).join(', ');
    const prefix = `INSERT INTO \`${table}\` (${colsPart}) VALUES `;
    const prefixLen = Buffer.byteLength(prefix, 'utf8') + 1; // +1 for ';'

    let valueParts: string[] = [];
    let currentLen = prefixLen;

    const flush = () => {
      if (valueParts.length === 0) return;
      result.push(`${prefix}${valueParts.join(',\n')};`);
      valueParts = [];
      currentLen = prefixLen;
    };

    for (const row of group) {
      const valuePart = `(${row.values.map(serializeSqlValue).join(', ')})`;
      // separator: ',\n' = 2 bytes for all but the first entry
      const addLen = Buffer.byteLength(valuePart, 'utf8') + 2;
      if (valueParts.length > 0 && (currentLen + addLen > maxContentLength || valueParts.length >= maxRowsPerBatch)) {
        flush();
      }
      valueParts.push(valuePart);
      currentLen += addLen;
    }
    flush();
  }
  return result;
}

export function processTable(tableName: string, unzippedDir: string): InsertRow[] {
  const mapping = tableMappings[tableName];
  if (!mapping) {
    throw new Error(`No mapping for ${tableName}`);
  }
  if (tableName === 'invUniqueNames') {
    const uniqueByID = new Map<number, {itemID: number, itemName: string, groupID: number}>();
    for (const fileName of mapping.files) {
      const filePath = path.join(unzippedDir, fileName);
      if (!fs.existsSync(filePath)) {
        console.warn(`File ${filePath} does not exist, skipping.`);
        continue;
      }
      for (const item of readJsonl(filePath)) {
        const itemID = item._key;
        const itemName = item.name?.en || '';
        const groupID = item.groupID;
        if (uniqueByID.has(itemID)) {
          const existing = uniqueByID.get(itemID)!;
          if (groupID < existing.groupID) {
            uniqueByID.set(itemID, {itemID, itemName, groupID});
          }
        } else {
          uniqueByID.set(itemID, {itemID, itemName, groupID});
        }
      }
    }
    // Now deduplicate by itemName (case-insensitive, matching MySQL utf8_general_ci),
    // keeping the one with smallest groupID
    const uniqueByName = new Map<string, {itemID: number, itemName: string, groupID: number}>();
    for (const entry of uniqueByID.values()) {
      const nameKey = entry.itemName.toLowerCase();
      if (uniqueByName.has(nameKey)) {
        const existing = uniqueByName.get(nameKey)!;
        if (entry.groupID < existing.groupID) {
          uniqueByName.set(nameKey, entry);
        }
      } else {
        uniqueByName.set(nameKey, entry);
      }
    }
    const rows: InsertRow[] = [];
    for (const entry of uniqueByName.values()) {
      rows.push({ table: 'invUniqueNames', columns: ['itemID', 'itemName', 'groupID'], values: [entry.itemID, entry.itemName, entry.groupID] });
    }
    return rows;
  } else if (tableName === 'invNames') {
    const processedItemIDs = new Set<number>();
    const rows: InsertRow[] = [];
    const columns = mapping.fields.map((f: any) => typeof f === 'string' ? f : f.name);
    for (const fileName of mapping.files) {
      const filePath = path.join(unzippedDir, fileName);
      if (!fs.existsSync(filePath)) {
        console.warn(`File ${filePath} does not exist, skipping.`);
        continue;
      }
      for (const item of readJsonl(filePath)) {
        const itemID = item._key;
        if (!processedItemIDs.has(itemID)) {
          processedItemIDs.add(itemID);
          rows.push({ table: tableName, columns, values: extractRawValues(item, mapping, fileName) });
        }
      }
    }
    return rows;
  } else if (tableName === 'trnTranslations') {
    // Special handling for translation data from multiple sources
    const rows: InsertRow[] = [];
    const trnCols = ['tcID', 'keyID', 'languageID', 'text'];
    const languages = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
    // avoid duplicates: track combination of tcID,keyID,languageID
    const seen = new Set<string>();

    function addRow(tcID: number, keyID: number, lang: string, text: string) {
      const key = `${tcID}|${keyID}|${lang}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ table: 'trnTranslations', columns: trnCols, values: [tcID, keyID, lang, text] });
    }

    for (const fileName of mapping.files) {
      const filePath = path.join(unzippedDir, fileName);
      if (!fs.existsSync(filePath)) {
        console.warn(`File ${filePath} does not exist, skipping.`);
        continue;
      }

      for (const item of readJsonl(filePath)) {
        const keyID: number = item._key;

        const pushTranslations = (tcID: number, nameMap: Record<string, string>) => {
          for (const lang of languages) {
            if (nameMap[lang]) {
              addRow(tcID, keyID, lang, nameMap[lang]);
            }
          }
        };

        // Handle different file types
        if (fileName === 'categories.jsonl' && item.name) {
          pushTranslations(6, item.name);   // tcID=6: invCategories.categoryName
        } else if (fileName === 'groups.jsonl' && item.name) {
          pushTranslations(7, item.name);   // tcID=7: invGroups.groupName
        } else if (fileName === 'types.jsonl') {
          if (item.name)        pushTranslations(8,  item.name);         // tcID=8:  invTypes.typeName
          if (item.description) pushTranslations(33, item.description);  // tcID=33: invTypes.description
        } else if (fileName === 'metaGroups.jsonl') {
          if (item.name)        pushTranslations(34, item.name);         // tcID=34: invMetaGroups.metaGroupName
          if (item.description) pushTranslations(35, item.description);  // tcID=35: invMetaGroups.description
        } else if (fileName === 'marketGroups.jsonl') {
          if (item.name)        pushTranslations(36, item.name);         // tcID=36: invMarketGroups.marketGroupName
          if (item.description) pushTranslations(37, item.description);  // tcID=37: invMarketGroups.description
        } else if (fileName === 'typeBonus.jsonl') {
          // tcID=1002: invTypes traits/bonus text – does not fit the schema, ignore
        } else if (fileName === 'mapSolarSystems.jsonl' && item.name) {
          pushTranslations(40, item.name);   // tcID=40: mapSolarSystems.solarSystemName
        } else if (fileName === 'mapConstellations.jsonl' && item.name) {
          pushTranslations(41, item.name);   // tcID=41: mapConstellations.constellationName
        } else if (fileName === 'mapRegions.jsonl' && item.name) {
          pushTranslations(42, item.name);   // tcID=42: mapRegions.regionName
        } else if (fileName === 'stationOperations.jsonl') {
          if (item.operationName) pushTranslations(46, item.operationName); // tcID=46: staOperations.operationName
          if (item.description)   pushTranslations(47, item.description);   // tcID=47: staOperations.description
        } else if (fileName === 'stationServices.jsonl') {
          if (item.serviceName)   pushTranslations(48, item.serviceName);   // tcID=48: staServices.serviceName
        } else if (fileName === 'dogmaUnits.jsonl') {
          if (item.displayName)   pushTranslations(58, item.displayName);   // tcID=58: eveUnits.displayName
          if (item.description)   pushTranslations(122, item.description);  // tcID=122: eveUnits.description
        } else if (fileName === 'dogmaEffects.jsonl') {
          if (item.displayName)   pushTranslations(74, item.displayName);   // tcID=74: dgmEffects.displayName
          if (item.description)   pushTranslations(75, item.description);   // tcID=75: dgmEffects.description
        } else if (fileName === 'landmarks.jsonl') {
          if (item.name)          pushTranslations(63, item.name);          // tcID=63: mapLandmarks.landmarkName
          if (item.description)   pushTranslations(64, item.description);   // tcID=64: mapLandmarks.description
        } else if (fileName === 'npcCorporationDivisions.jsonl') {
          if (item.name)           pushTranslations(65, item.name);           // tcID=65: crpNPCDivisions.divisionName
          if (item.leaderTypeName) pushTranslations(66, item.leaderTypeName); // tcID=66: crpNPCDivisions.leaderType
        } else if (fileName === 'planetSchematics.jsonl') {
          if (item.name)          pushTranslations(119, item.name);         // tcID=119: planetSchematics.schematicName
        } else if (fileName === 'npcCorporations.jsonl') {
          if (item.description)   pushTranslations(138, item.description);  // tcID=138: crpNPCCorporations.description
        }
      }
    }

    return rows;
  } else if (tableName === 'industryActivity') {
    const activityIdMap: Record<string, number> = {
      'manufacturing': 1, 'research_time': 3, 'research_material': 4,
      'copying': 5, 'invention': 8, 'reaction': 11
    };
    const rows: InsertRow[] = [];
    for (const fileName of mapping.files) {
      const filePath = path.join(unzippedDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      for (const item of readJsonl(filePath)) {
        const typeID = item.blueprintTypeID;
        if (!item.activities) continue;
        for (const [actName, actData] of Object.entries(item.activities) as [string, any][]) {
          const activityID = activityIdMap[actName];
          if (activityID === undefined) continue;
          rows.push({ table: 'industryActivity', columns: ['typeID', 'activityID', 'time'], values: [typeID, activityID, actData.time ?? null] });
        }
      }
    }
    return rows;
  } else if (tableName === 'industryActivityMaterials') {
    const activityIdMap: Record<string, number> = {
      'manufacturing': 1, 'research_time': 3, 'research_material': 4,
      'copying': 5, 'invention': 8, 'reaction': 11
    };
    const rows: InsertRow[] = [];
    for (const fileName of mapping.files) {
      const filePath = path.join(unzippedDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      for (const item of readJsonl(filePath)) {
        const typeID = item.blueprintTypeID;
        if (!item.activities) continue;
        for (const [actName, actData] of Object.entries(item.activities) as [string, any][]) {
          const activityID = activityIdMap[actName];
          if (activityID === undefined || !Array.isArray(actData.materials)) continue;
          for (const mat of actData.materials) {
            rows.push({ table: 'industryActivityMaterials', columns: ['typeID', 'activityID', 'materialTypeID', 'quantity'], values: [typeID, activityID, mat.typeID, mat.quantity] });
          }
        }
      }
    }
    return rows;
  } else if (tableName === 'industryActivityProducts') {
    const activityIdMap: Record<string, number> = {
      'manufacturing': 1, 'research_time': 3, 'research_material': 4,
      'copying': 5, 'invention': 8, 'reaction': 11
    };
    const rows: InsertRow[] = [];
    for (const fileName of mapping.files) {
      const filePath = path.join(unzippedDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      for (const item of readJsonl(filePath)) {
        const typeID = item.blueprintTypeID;
        if (!item.activities) continue;
        for (const [actName, actData] of Object.entries(item.activities) as [string, any][]) {
          const activityID = activityIdMap[actName];
          if (activityID === undefined || !Array.isArray(actData.products)) continue;
          for (const prod of actData.products) {
            rows.push({ table: 'industryActivityProducts', columns: ['typeID', 'activityID', 'productTypeID', 'quantity'], values: [typeID, activityID, prod.typeID, prod.quantity] });
          }
        }
      }
    }
    return rows;
  } else if (tableName === 'industryActivityProbabilities') {
    const activityIdMap: Record<string, number> = {
      'manufacturing': 1, 'research_time': 3, 'research_material': 4,
      'copying': 5, 'invention': 8, 'reaction': 11
    };
    const rows: InsertRow[] = [];
    for (const fileName of mapping.files) {
      const filePath = path.join(unzippedDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      for (const item of readJsonl(filePath)) {
        const typeID = item.blueprintTypeID;
        if (!item.activities) continue;
        for (const [actName, actData] of Object.entries(item.activities) as [string, any][]) {
          const activityID = activityIdMap[actName];
          if (activityID === undefined || !Array.isArray(actData.products)) continue;
          for (const prod of actData.products) {
            if (prod.probability != null) {
              rows.push({ table: 'industryActivityProbabilities', columns: ['typeID', 'activityID', 'productTypeID', 'probability'], values: [typeID, activityID, prod.typeID, prod.probability] });
            }
          }
        }
      }
    }
    return rows;
  } else if (tableName === 'industryActivitySkills') {
    const activityIdMap: Record<string, number> = {
      'manufacturing': 1, 'research_time': 3, 'research_material': 4,
      'copying': 5, 'invention': 8, 'reaction': 11
    };
    const rows: InsertRow[] = [];
    for (const fileName of mapping.files) {
      const filePath = path.join(unzippedDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      for (const item of readJsonl(filePath)) {
        const typeID = item.blueprintTypeID;
        if (!item.activities) continue;
        for (const [actName, actData] of Object.entries(item.activities) as [string, any][]) {
          const activityID = activityIdMap[actName];
          if (activityID === undefined || !Array.isArray(actData.skills)) continue;
          for (const skill of actData.skills) {
            rows.push({ table: 'industryActivitySkills', columns: ['typeID', 'activityID', 'skillID', 'level'], values: [typeID, activityID, skill.typeID, skill.level] });
          }
        }
      }
    }
    return rows;
  } else if (tableName === 'invTraits') {
    // Auto-increment traitID, flatten roleBonuses (skillID=-1) and types (skillID=type._key)
    const rows: InsertRow[] = [];
    let traitID = 1;
    for (const fileName of mapping.files) {
      const filePath = path.join(unzippedDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      for (const item of readJsonl(filePath)) {
        const typeID = item._key;
        if (Array.isArray(item.roleBonuses)) {
          for (const rb of item.roleBonuses) {
            rows.push({ table: 'invTraits', columns: ['traitID', 'typeID', 'skillID', 'bonus', 'bonusText', 'unitID'], values: [traitID++, typeID, -1, rb.bonus, rb.bonusText?.en || null, rb.unitID ?? null] });
          }
        }
        if (Array.isArray(item.types)) {
          for (const t of item.types) {
            const skillID = t._key;
            if (Array.isArray(t._value)) {
              for (const bonus of t._value) {
                rows.push({ table: 'invTraits', columns: ['traitID', 'typeID', 'skillID', 'bonus', 'bonusText', 'unitID'], values: [traitID++, typeID, skillID, bonus.bonus, bonus.bonusText?.en || null, bonus.unitID ?? null] });
              }
            }
          }
        }
      }
    }
    return rows;
  } else if (tableName === 'certMasteries') {
    // masteries.jsonl: _key = typeID, _value = [{_key: masteryLevel, _value: [certID, ...]}]
    const rows: InsertRow[] = [];
    for (const fileName of mapping.files) {
      const filePath = path.join(unzippedDir, fileName);
      if (!fs.existsSync(filePath)) { console.warn(`File ${filePath} does not exist, skipping.`); continue; }
      for (const item of readJsonl(filePath)) {
        const typeID: number = item._key;
        if (!Array.isArray(item._value)) continue;
        for (const masteryEntry of item._value) {
          const masteryLevel: number = masteryEntry._key;
          if (!Array.isArray(masteryEntry._value)) continue;
          for (const certID of masteryEntry._value) {
            rows.push({ table: 'certMasteries', columns: ['typeID', 'masteryLevel', 'certID'], values: [typeID, masteryLevel, certID] });
          }
        }
      }
    }
    return rows;
  } else if (tableName === 'certSkills') {
    // certificates.jsonl: _key = certID, skillTypes = [{_key: skillID, basic, standard, improved, advanced, elite}]
    const rows: InsertRow[] = [];
    const levelMap: Array<{ name: keyof typeof levelInt; int: number; text: string }> = [
      { name: 'basic',    int: 1, text: 'basic'    },
      { name: 'standard', int: 2, text: 'standard' },
      { name: 'improved', int: 3, text: 'improved' },
      { name: 'advanced', int: 4, text: 'advanced' },
      { name: 'elite',    int: 5, text: 'elite'    },
    ];
    const levelInt = { basic: 1, standard: 2, improved: 3, advanced: 4, elite: 5 };
    for (const fileName of mapping.files) {
      const filePath = path.join(unzippedDir, fileName);
      if (!fs.existsSync(filePath)) { console.warn(`File ${filePath} does not exist, skipping.`); continue; }
      for (const item of readJsonl(filePath)) {
        const certID: number = item._key;
        if (!Array.isArray(item.skillTypes)) continue;
        for (const st of item.skillTypes) {
          const skillID: number = st._key;
          for (const lv of levelMap) {
            const skillLevel: number = st[lv.name];
            if (skillLevel == null || skillLevel === 0) continue;
            rows.push({ table: 'certSkills', columns: ['certID', 'skillID', 'certLevelInt', 'skillLevel', 'certLevelText'], values: [certID, skillID, lv.int, skillLevel, lv.text] });
          }
        }
      }
    }
    return rows;
  } else if (tableName === 'trnTranslationLanguages') {
    // Assign sequential numericLanguageID to each language
    const rows: InsertRow[] = [];
    let numericID = 1;
    for (const fileName of mapping.files) {
      const filePath = path.join(unzippedDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      for (const item of readJsonl(filePath)) {
        rows.push({ table: 'trnTranslationLanguages', columns: ['numericLanguageID', 'languageID', 'languageName'], values: [numericID++, item._key, item.name] });
      }
    }
    return rows;
  } else if (tableName === 'mapSolarSystemJumps' || tableName === 'mapConstellationJumps' || tableName === 'mapRegionJumps') {
    // Build solar system → constellation/region lookup
    const systemInfo = new Map<number, { constellationID: number; regionID: number }>();
    const systemsPath = path.join(unzippedDir, 'mapSolarSystems.jsonl');
    if (fs.existsSync(systemsPath)) {
      for (const item of readJsonl(systemsPath)) {
        systemInfo.set(item._key, { constellationID: item.constellationID, regionID: item.regionID });
      }
    }
    const stargatesPath = path.join(unzippedDir, 'mapStargates.jsonl');
    if (!fs.existsSync(stargatesPath)) return [];

    if (tableName === 'mapSolarSystemJumps') {
      const rows: InsertRow[] = [];
      const seen = new Set<string>();
      for (const item of readJsonl(stargatesPath)) {
        const fromSystem = item.solarSystemID;
        const toSystem = item.destination?.solarSystemID;
        if (!fromSystem || !toSystem) continue;
        const key = `${fromSystem}|${toSystem}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const fromInfo = systemInfo.get(fromSystem) || { constellationID: null as any, regionID: null as any };
        const toInfo = systemInfo.get(toSystem) || { constellationID: null as any, regionID: null as any };
        rows.push({ table: 'mapSolarSystemJumps', columns: ['fromRegionID', 'fromConstellationID', 'fromSolarSystemID', 'toSolarSystemID', 'toConstellationID', 'toRegionID'], values: [fromInfo.regionID, fromInfo.constellationID, fromSystem, toSystem, toInfo.constellationID, toInfo.regionID] });
      }
      return rows;
    } else if (tableName === 'mapConstellationJumps') {
      const rows: InsertRow[] = [];
      const seen = new Set<string>();
      for (const item of readJsonl(stargatesPath)) {
        const fromSystem = item.solarSystemID;
        const toSystem = item.destination?.solarSystemID;
        if (!fromSystem || !toSystem) continue;
        const fromInfo = systemInfo.get(fromSystem);
        const toInfo = systemInfo.get(toSystem);
        if (!fromInfo || !toInfo) continue;
        if (fromInfo.constellationID === toInfo.constellationID) continue;
        const key = `${fromInfo.constellationID}|${toInfo.constellationID}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ table: 'mapConstellationJumps', columns: ['fromRegionID', 'fromConstellationID', 'toConstellationID', 'toRegionID'], values: [fromInfo.regionID, fromInfo.constellationID, toInfo.constellationID, toInfo.regionID] });
      }
      return rows;
    } else {
      // mapRegionJumps
      const rows: InsertRow[] = [];
      const seen = new Set<string>();
      for (const item of readJsonl(stargatesPath)) {
        const fromSystem = item.solarSystemID;
        const toSystem = item.destination?.solarSystemID;
        if (!fromSystem || !toSystem) continue;
        const fromInfo = systemInfo.get(fromSystem);
        const toInfo = systemInfo.get(toSystem);
        if (!fromInfo || !toInfo) continue;
        if (fromInfo.regionID === toInfo.regionID) continue;
        const key = `${fromInfo.regionID}|${toInfo.regionID}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ table: 'mapRegionJumps', columns: ['fromRegionID', 'toRegionID'], values: [fromInfo.regionID, toInfo.regionID] });
      }
      return rows;
    }
  } else {
    const rows: InsertRow[] = [];
    const columns: string[] = mapping.fields.map((f: any) => typeof f === 'string' ? f : f.name);
    const materialTypeIDIndex = tableName === 'invTypeMaterials'
      ? columns.indexOf('materialTypeID')
      : -1;
    for (const fileName of mapping.files) {
      const filePath = path.join(unzippedDir, fileName);
      if (!fs.existsSync(filePath)) {
        console.warn(`File ${filePath} does not exist, skipping.`);
        continue;
      }
      for (const item of readJsonl(filePath)) {
        if (mapping.filter && !mapping.filter(item)) {
          continue;
        }
        if (mapping.expand && Array.isArray(item[mapping.expand])) {
          // Expand array into multiple rows
          for (const subItem of item[mapping.expand]) {
            const values: SqlValue[] = mapping.fields.map((field: any) => {
              let value: SqlValue;
              if (typeof field === 'string') {
                const fieldName: string = field;
                if (fieldName === 'agentID' && item._key !== undefined) {
                  value = item._key;
                } else if (fieldName === 'typeID' && item._key !== undefined) {
                  value = item._key;
                } else {
                  value = item[fieldName] ?? subItem[fieldName];
                }
              } else {
                value = field.transform(item, subItem, fileName);
              }
              return value ?? null;
            });
            if (materialTypeIDIndex !== -1 && values[materialTypeIDIndex] == null) continue;
            rows.push({ table: tableName, columns, values });
          }
        } else {
          const values = extractRawValues(item, mapping, fileName);
          if (materialTypeIDIndex !== -1 && values[materialTypeIDIndex] == null) continue;
          rows.push({ table: tableName, columns, values });
        }
      }
    }
    return rows;
  }
}

export function generateMySqlDump(schemaPath: string, unzippedDir: string, outputPath: string, tableName?: string): void {
  // Build name cache for celestial objects before processing any tables
  celestialNameCache = buildNameCache(unzippedDir);

  let dump = fs.readFileSync(schemaPath, 'utf-8');
  const lines = dump.split('\n');
  const newLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    newLines.push(lines[i]);
    // Look for DISABLE KEYS line
    if (lines[i].includes('DISABLE KEYS')) {
      // Find the table name from previous lines
      let currentTableName = '';
      for (let j = i - 1; j >= 0; j--) {
        if (lines[j].includes('LOCK TABLES `')) {
          const match = lines[j].match(/LOCK TABLES `([^`]+)`/);
          if (match) {
            currentTableName = match[1];
            break;
          }
        }
      }
      if (currentTableName && tableMappings[currentTableName] && (!tableName || currentTableName === tableName)) {
        try {
          const rows = processTable(currentTableName, unzippedDir);
          for (const line of serializeInsertRows(rows)) {
            newLines.push(line);
          }
        } catch (e: any) {
          console.warn(`Skipping ${currentTableName}: ${e.message}`);
        }
      }
    }
  }

  fs.writeFileSync(outputPath, newLines.join('\n'));
}

export function convertToSqlite(mysqlDumpPath: string, sqlitePath: string, mysql2sqlitePath: string): void {
  const command = `awk -f ${mysql2sqlitePath} ${mysqlDumpPath} | sqlite3 ${sqlitePath}`; // -echo -bail
  console.log(command);
  // process.exit();
  execSync(command, { stdio: 'inherit' });
}

export function convertToPgsql(mysqlDumpPath: string, pgsqlPath: string, mysql2pgsqlPath: string): void {
  const command = `awk -f ${mysql2pgsqlPath} ${mysqlDumpPath} > ${pgsqlPath}`;
  console.log(command);
  execSync(command, { stdio: 'inherit' });
}

/**
 * Convert a MySQL column type string to PostgreSQL equivalent.
 */
function mysqlTypeToPgsql(mysqlType: string): string {
  let t = mysqlType.trim();
  // Remove UNSIGNED
  t = t.replace(/\s+unsigned/i, '');
  // Remove character set / collate
  t = t.replace(/\s+CHARACTER\s+SET\s+\S+/i, '');
  t = t.replace(/\s+COLLATE\s+\S+/i, '');

  // bigint(N) -> BIGINT  (must come before int)
  if (/^bigint/i.test(t)) return 'BIGINT';
  // mediumint(N) -> INTEGER
  if (/^mediumint/i.test(t)) return 'INTEGER';
  // smallint(N) -> SMALLINT
  if (/^smallint/i.test(t)) return 'SMALLINT';
  // tinyint(N) -> SMALLINT
  if (/^tinyint/i.test(t)) return 'SMALLINT';
  // int(N) -> BIGINT (MySQL schema display width doesn't cap real storage,
  // and actual SDE data can exceed INT32 range e.g. crpNPCCorporations.publicShares)
  if (/^int/i.test(t)) return 'BIGINT';

  // float -> REAL
  if (/^float/i.test(t)) return 'REAL';
  // double -> DOUBLE PRECISION
  if (/^double/i.test(t)) return 'DOUBLE PRECISION';

  // decimal(M,N) -> NUMERIC(M,N)
  const decMatch = t.match(/^decimal\((\d+),\s*(\d+)\)/i);
  if (decMatch) return `NUMERIC(${decMatch[1]},${decMatch[2]})`;
  if (/^decimal/i.test(t)) return 'NUMERIC';

  // varchar(N) -> TEXT (avoid length overflow; PG TEXT is equivalent to unlimited varchar)
  const varcharMatch = t.match(/^varchar\((\d+)\)/i);
  if (varcharMatch) return 'TEXT';

  // text variants
  if (/^(longtext|mediumtext|tinytext|text)/i.test(t)) return 'TEXT';

  return t;
}

/**
 * Convert MySQL schema.sql DDL into PostgreSQL DDL (pure TypeScript).
 * Returns the full PG schema as a string.
 */
function convertMysqlSchemaToPgsql(schemaContent: string): string {
  const lines = schemaContent.split('\n');
  const out: string[] = [];
  // Collect CREATE INDEX statements derived from KEY lines
  const indexStatements: string[] = [];
  let currentTable = '';
  let inCreate = false;
  let createLines: string[] = [];

  out.push('-- PostgreSQL dump converted from MySQL schema');
  out.push("SET client_encoding = 'UTF8';");
  out.push('SET standard_conforming_strings = on;');
  out.push('');

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Skip MySQL-specific comment directives /*!...*/
    if (/^\/\*!\d+/.test(line)) continue;
    // Skip LOCK/UNLOCK TABLES
    if (/^(LOCK TABLES|UNLOCK TABLES)/i.test(line)) continue;

    // DROP TABLE
    if (/^DROP TABLE IF EXISTS/i.test(line)) {
      const tbl = line.match(/`([^`]+)`/)?.[1] || '';
      out.push(`DROP TABLE IF EXISTS "${tbl}" CASCADE;`);
      continue;
    }

    // Start of CREATE TABLE
    if (/^CREATE TABLE/i.test(line)) {
      currentTable = line.match(/`([^`]+)`/)?.[1] || '';
      inCreate = true;
      createLines = [];
      continue;
    }

    // Inside CREATE TABLE body
    if (inCreate) {
      // End of CREATE TABLE (ENGINE= line)
      if (/^\)\s*ENGINE/i.test(line)) {
        // Emit PG CREATE TABLE
        out.push(`CREATE TABLE "${currentTable}" (`);
        for (let i = 0; i < createLines.length; i++) {
          const comma = i < createLines.length - 1 ? ',' : '';
          out.push(`  ${createLines[i]}${comma}`);
        }
        out.push(');');
        out.push('');
        inCreate = false;
        currentTable = '';
        continue;
      }

      // Parse the line
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--')) continue;

      // Remove trailing comma
      const cleaned = trimmed.replace(/,\s*$/, '');

      // PRIMARY KEY
      const pkMatch = cleaned.match(/^PRIMARY KEY\s*\((.+)\)/i);
      if (pkMatch) {
        const pkCols = pkMatch[1].replace(/`/g, '"');
        createLines.push(`PRIMARY KEY (${pkCols})`);
        continue;
      }

      // UNIQUE KEY `name` (cols) -> UNIQUE (cols)  +  CREATE UNIQUE INDEX
      const ukMatch = cleaned.match(/^UNIQUE KEY\s+`([^`]+)`\s*\((.+)\)/i);
      if (ukMatch) {
        const idxName = ukMatch[1];
        const idxCols = ukMatch[2].replace(/`/g, '"');
        createLines.push(`UNIQUE (${idxCols})`);
        // Also create named index for queries relying on index name
        indexStatements.push(`CREATE UNIQUE INDEX "${idxName}" ON "${currentTable}" (${idxCols});`);
        continue;
      }

      // KEY `name` (cols) -> CREATE INDEX (not part of CREATE TABLE)
      const keyMatch = cleaned.match(/^KEY\s+`([^`]+)`\s*\((.+)\)/i);
      if (keyMatch) {
        const idxName = keyMatch[1];
        let idxCols = keyMatch[2].replace(/`/g, '"');
        // Remove key-length hints like (10)
        idxCols = idxCols.replace(/\(\d+\)/g, '');
        indexStatements.push(`CREATE INDEX "${idxName}" ON "${currentTable}" (${idxCols});`);
        continue;
      }

      // CONSTRAINT ... CHECK (...)  - PG supports this natively
      const constraintMatch = cleaned.match(/^CONSTRAINT\s+`([^`]+)`\s+CHECK\s*\((.+)\)/i);
      if (constraintMatch) {
        const cName = constraintMatch[1];
        const cExpr = constraintMatch[2].replace(/`/g, '"');
        createLines.push(`CONSTRAINT "${cName}" CHECK (${cExpr})`);
        continue;
      }

      // Column definition
      const colMatch = cleaned.match(/^`([^`]+)`\s+(.+)/);
      if (colMatch) {
        const colName = colMatch[1];
        let rest = colMatch[2];
        // Extract type (first word or type with parens)
        const typeMatch = rest.match(/^(\S+(?:\([^)]*\))?)\s*(.*)/);
        if (typeMatch) {
          const mysqlType = typeMatch[1];
          let modifiers = typeMatch[2];
          const pgType = mysqlTypeToPgsql(mysqlType);

          // Clean modifiers
          modifiers = modifiers.replace(/\s+unsigned/gi, '');
          modifiers = modifiers.replace(/\s+AUTO_INCREMENT/gi, '');
          modifiers = modifiers.replace(/\s+CHARACTER\s+SET\s+\S+/gi, '');
          modifiers = modifiers.replace(/\s+COLLATE\s+\S+/gi, '');
          modifiers = modifiers.replace(/\s+COMMENT\s+'[^']*'/gi, '');
          modifiers = modifiers.replace(/\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP(\(\))?/gi, '');
          modifiers = modifiers.replace(/\s+DEFAULT\s+CURRENT_TIMESTAMP(\(\))?/gi, ' DEFAULT CURRENT_TIMESTAMP');

          createLines.push(`"${colName}" ${pgType}${modifiers ? ' ' + modifiers.trim() : ''}`);
        }
        continue;
      }
    }

    // Pre-existing INSERT statements (e.g. invFlags)
    if (/^INSERT INTO/i.test(line)) {
      // Convert backticks to double quotes
      let pgLine = line.replace(/`/g, '"');
      out.push(pgLine);
      continue;
    }

    // Comments
    if (line.startsWith('--')) {
      out.push(line);
      continue;
    }
  }

  // Append index creation
  if (indexStatements.length > 0) {
    out.push('');
    out.push('-- Indexes');
    for (const idx of indexStatements) out.push(idx);
  }

  out.push('');
  return out.join('\n');
}

/**
 * Serialize InsertRow objects as PostgreSQL INSERT statements.
 * Uses double-quoted identifiers instead of backticks.
 */
function serializeInsertRowsPgsql(rows: InsertRow[], maxContentLength: number = 800 * 1024): string[] {
  if (rows.length === 0) return [];

  const groups = new Map<string, InsertRow[]>();
  for (const row of rows) {
    const key = `${row.table}\0${row.columns.join('\0')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const result: string[] = [];
  for (const group of groups.values()) {
    const { table, columns } = group[0];
    const colsPart = columns.map(c => `"${c}"`).join(', ');
    const prefix = `INSERT INTO "${table}" (${colsPart}) VALUES `;
    const prefixLen = Buffer.byteLength(prefix, 'utf8') + 1;

    let valueParts: string[] = [];
    let currentLen = prefixLen;

    const flush = () => {
      if (valueParts.length === 0) return;
      result.push(`${prefix}${valueParts.join(',\n')};`);
      valueParts = [];
      currentLen = prefixLen;
    };

    for (const row of group) {
      const valuePart = `(${row.values.map(serializeSqlValue).join(', ')})`;
      const addLen = Buffer.byteLength(valuePart, 'utf8') + 2;
      if (valueParts.length > 0 && currentLen + addLen > maxContentLength) flush();
      valueParts.push(valuePart);
      currentLen += addLen;
    }
    flush();
  }
  return result;
}

/**
 * Generate PostgreSQL dump directly from JSONL data (no awk conversion).
 * Converts MySQL schema to PG DDL, then fills with PG INSERT statements.
 */
export function generatePgsqlDump(
  schemaPath: string,
  unzippedDir: string,
  outputPath: string,
  tableName?: string,
): void {
  celestialNameCache = buildNameCache(unzippedDir);

  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
  const pgSchema = convertMysqlSchemaToPgsql(schemaContent);

  // Split PG schema to insert data after each table's CREATE TABLE + pre-existing INSERTs
  // Strategy: just append all INSERT statements at the end (after schema)
  const dataLines: string[] = [];

  // Parse schema.sql to find tables, same logic as generateMySqlDump
  const schemaLines = schemaContent.split('\n');
  for (let i = 0; i < schemaLines.length; i++) {
    if (schemaLines[i].includes('DISABLE KEYS')) {
      let currentTableName = '';
      for (let j = i - 1; j >= 0; j--) {
        if (schemaLines[j].includes('LOCK TABLES `')) {
          const match = schemaLines[j].match(/LOCK TABLES `([^`]+)`/);
          if (match) {
            currentTableName = match[1];
            break;
          }
        }
      }
      if (currentTableName && tableMappings[currentTableName] && (!tableName || currentTableName === tableName)) {
        try {
          const rows = processTable(currentTableName, unzippedDir);
          for (const line of serializeInsertRowsPgsql(rows)) {
            dataLines.push(line);
          }
        } catch (e: any) {
          console.warn(`Skipping ${currentTableName}: ${e.message}`);
        }
      }
    }
  }

  const output = pgSchema + '\n-- Data\n' + dataLines.join('\n') + '\n';
  fs.writeFileSync(outputPath, output);
}

export const tableMappings: Record<string, { files: string[]; fields: Array<string | { name: string; transform: (item: any, subItem?: any, fileName?: string) => any }>; expand?: string; filter?: (item: any) => boolean }> = {
  'agtAgents': {
    files: ['npcCharacters.jsonl'],
    fields: [
      { name: 'agentID', transform: (item) => item._key },
      { name: 'divisionID', transform: (item) => item.agent?.divisionID },
      'corporationID',
      'locationID',
      { name: 'level', transform: (item) => item.agent?.level },
      { name: 'agentTypeID', transform: (item) => item.agent?.agentTypeID },
      { name: 'isLocator', transform: (item) => item.agent?.isLocator }
    ],
    filter: (item) => item.agent != null
  },
  'agtAgentTypes': {
    files: ['agentTypes.jsonl'],
    fields: [
      { name: 'agentTypeID', transform: (item) => item._key },
      { name: 'agentType', transform: (item) => item.name }
    ]
  },
  'agtAgentsInSpace': {
    files: ['agentsInSpace.jsonl'],
    fields: ['agentID', 'dungeonID', 'solarSystemID', 'spawnPointID', 'typeID']
  },
  'invCategories': {
    files: ['categories.jsonl'],
    fields: [
      { name: 'categoryID', transform: (item) => item._key },
      { name: 'categoryName', transform: (item) => item.name?.en || '' },
      'iconID',
      'published'
    ]
  },
  'invGroups': {
    files: ['groups.jsonl'],
    fields: [
      { name: 'groupID', transform: (item) => item._key },
      'categoryID',
      { name: 'groupName', transform: (item) => item.name?.en || '' },
      'iconID',
      'useBasePrice',
      'anchored',
      'anchorable',
      'fittableNonSingleton',
      'published'
    ]
  },
  'invTypes': {
    files: ['types.jsonl'],
    fields: [
      { name: 'typeID', transform: (item) => item._key },
      'groupID',
      { name: 'typeName', transform: (item) => item.name?.en || '' },
      { name: 'description', transform: (item) => item.description?.en || '' },
      'mass',
      'volume',
      'capacity',
      'portionSize',
      'raceID',
      'basePrice',
      'published',
      'marketGroupID',
      'iconID',
      'soundID',
      'graphicID'
    ]
  },
  'dgmTypeAttributes': {
    files: ['typeDogma.jsonl'],
    fields: [
      { name: 'typeID', transform: (item) => item._key },
      { name: 'attributeID', transform: (item, subItem) => subItem?.attributeID },
      {
        name: 'valueInt',
        transform: (item, subItem) => {
          const v = subItem?.value;
          if (v == null) return null;
          return Number.isInteger(v) ? v : null;
        }
      },
      {
        name: 'valueFloat',
        transform: (item, subItem) => {
          const v = subItem?.value;
          if (v == null) return null;
          return Number.isInteger(v) ? null : v;
        }
      }
    ],
    expand: 'dogmaAttributes'
  },
  'dgmTypeEffects': {
    files: ['typeDogma.jsonl'],
    fields: [
      { name: 'typeID', transform: (item) => item._key },
      { name: 'effectID', transform: (item, subItem) => subItem?.effectID },
      { name: 'isDefault', transform: (item, subItem) => subItem?.isDefault }
    ],
    expand: 'dogmaEffects',
    filter: (item) => Array.isArray(item.dogmaEffects) && item.dogmaEffects.length > 0 && item.dogmaEffects.some((eff: any) => eff?.effectID)
  },
  'invContrabandTypes': {
    files: ['contrabandTypes.jsonl'],
    expand: 'factions',
    fields: [
      { name: 'factionID', transform: (item, subItem) => subItem._key },
      { name: 'typeID', transform: (item) => item._key },
      'standingLoss',
      'confiscateMinSec',
      'fineByValue',
      'attackMinSec'
    ]
  },
  'invControlTowerResources': {
    files: ['controlTowerResources.jsonl'],
    expand: 'resources',
    fields: [
      { name: 'controlTowerTypeID', transform: (item) => item._key },
      'resourceTypeID',
      'purpose',
      'quantity',
      'minSecurityLevel',
      'factionID'
    ]
  },
  'invMarketGroups': {
    files: ['marketGroups.jsonl'],
    fields: [
      { name: 'marketGroupID', transform: (item) => item._key },
      { name: 'parentGroupID', transform: (item) => item.parentGroupID || null },
      { name: 'marketGroupName', transform: (item) => item.name?.en || '' },
      { name: 'description', transform: (item) => item.description?.en || '' },
      'iconID',
      'hasTypes'
    ]
  },
  'invMetaGroups': {
    files: ['metaGroups.jsonl'],
    fields: [
      { name: 'metaGroupID', transform: (item) => item._key },
      { name: 'metaGroupName', transform: (item) => item.name?.en || '' },
      'iconID'
    ]
  },
  'invTypeMaterials': {
    files: ['typeMaterials.jsonl'],
    fields: [
      { name: 'typeID', transform: (item) => item._key },
      { name: 'materialTypeID', transform: (item, subItem) => subItem?.materialTypeID },
      { name: 'quantity', transform: (item, subItem) => subItem?.quantity }
    ],
    expand: 'materials'
  },
  'invMetaTypes': {
    files: ['types.jsonl'],
    fields: [
      { name: 'typeID', transform: (item) => item._key },
      { name: 'parentTypeID', transform: (item) => item.variationParentTypeID },
      { name: 'metaGroupID', transform: (item) => item.metaGroupID }
    ],
    filter: (item) => item.metaGroupID != null && item.metaGroupID !== undefined
  },
  'mapDenormalize': {
    files: ['mapSolarSystems.jsonl', 'mapConstellations.jsonl', 'mapRegions.jsonl', 'mapPlanets.jsonl', 'mapMoons.jsonl', 'mapAsteroidBelts.jsonl', 'mapStargates.jsonl', 'mapStars.jsonl'],
    fields: [
      { name: 'itemID', transform: (item) => item._key },
      { name: 'typeID', transform: (item, fileName) => {
        // Determine typeID based on file
        if (fileName === 'mapRegions.jsonl') return 3;
        if (fileName === 'mapConstellations.jsonl') return 4;
        if (fileName === 'mapSolarSystems.jsonl') return 5;
        if (fileName === 'mapPlanets.jsonl') return item.typeID;
        if (fileName === 'mapMoons.jsonl') return item.typeID;
        if (fileName === 'mapAsteroidBelts.jsonl') return item.typeID;
        if (fileName === 'mapStargates.jsonl') return item.typeID;
        if (fileName === 'mapStars.jsonl') return item.typeID;
        return null;
      }},
      { name: 'groupID', transform: (item, fileName) => {
        // Determine groupID based on file
        if (fileName === 'mapSolarSystems.jsonl') return 5;
        if (fileName === 'mapConstellations.jsonl') return 4;
        if (fileName === 'mapRegions.jsonl') return 3;
        if (fileName === 'mapPlanets.jsonl') return 7; // Assuming planet group
        if (fileName === 'mapMoons.jsonl') return 8; // Assuming moon group
        if (fileName === 'mapAsteroidBelts.jsonl') return 9; // Assuming asteroid belt group
        if (fileName === 'mapStargates.jsonl') return 10; // Assuming stargate group
        if (fileName === 'mapStars.jsonl') return 6; // Assuming star group
        return null;
      }},
      'solarSystemID',
      'constellationID',
      'regionID',
      'orbitID',
      { name: 'x', transform: (item) => item.position?.x || null },
      { name: 'y', transform: (item) => item.position?.y || null },
      { name: 'z', transform: (item) => item.position?.z || null },
      'radius',
      { name: 'itemName', transform: (item, fileName) => {
        return item.name?.en || celestialNameCache.get(item._key) || '';
      }},
      'security',
      'celestialIndex',
      'orbitIndex'
    ]
  },
  'invNames': {
    files: ['types.jsonl', 'ancestries.jsonl', 'bloodlines.jsonl', 'categories.jsonl', 'certificates.jsonl', 'characterAttributes.jsonl', 'corporationActivities.jsonl', 'factions.jsonl', 'groups.jsonl', 'landmarks.jsonl', 'mapConstellations.jsonl', 'mapRegions.jsonl', 'mapSolarSystems.jsonl', 'marketGroups.jsonl', 'metaGroups.jsonl', 'npcCorporationDivisions.jsonl', 'npcCorporations.jsonl', 'planetSchematics.jsonl', 'races.jsonl', 'mapStars.jsonl', 'mapPlanets.jsonl', 'mapMoons.jsonl', 'mapAsteroidBelts.jsonl', 'mapStargates.jsonl', 'npcStations.jsonl'],
    fields: [
      { name: 'itemID', transform: (item) => item._key },
      { name: 'itemName', transform: (item) => item.name?.en || celestialNameCache.get(item._key) || '' }
    ]
  },
  'invUniqueNames': {
    files: ['certificates.jsonl', 'types.jsonl'],
    fields: [
      { name: 'itemID', transform: (item) => item._key },
      { name: 'itemName', transform: (item) => item.name?.en || '' },
      { name: 'groupID', transform: (item) => item.groupID }
    ]
  },
  'certCerts': {
    files: ['certificates.jsonl'],
    fields: [
      { name: 'certID', transform: (item) => item._key },
      { name: 'description', transform: (item) => item.description?.en || null },
      'groupID',
      { name: 'name', transform: (item) => item.name?.en || '' }
    ]
  },
  'certMasteries': {
    files: ['masteries.jsonl'],
    fields: [] // Custom processing in processTable function
  },
  'certSkills': {
    files: ['certificates.jsonl'],
    fields: [] // Custom processing in processTable function
  },
  'chrAncestries': {
    files: ['ancestries.jsonl'],
    fields: [
      { name: 'ancestryID', transform: (item: any) => item._key },
      { name: 'ancestryName', transform: (item: any) => item.name?.en || '' },
      'bloodlineID',
      { name: 'description', transform: (item: any) => item.description?.en || null },
      'perception',
      'willpower',
      'charisma',
      'memory',
      'intelligence',
      'iconID',
      { name: 'shortDescription', transform: (item: any) => item.shortDescription || null }
    ]
  },
  'chrAttributes': {
    files: ['characterAttributes.jsonl'],
    fields: [
      { name: 'attributeID', transform: (item: any) => item._key },
      { name: 'attributeName', transform: (item: any) => item.name?.en || '' },
      { name: 'description', transform: (item: any) => item.description || null },
      'iconID',
      { name: 'shortDescription', transform: (item: any) => item.shortDescription || null },
      { name: 'notes', transform: (item: any) => item.notes || null }
    ]
  },
  'chrBloodlines': {
    files: ['bloodlines.jsonl'],
    fields: [
      { name: 'bloodlineID', transform: (item: any) => item._key },
      { name: 'bloodlineName', transform: (item: any) => item.name?.en || '' },
      'raceID',
      { name: 'description', transform: (item: any) => item.description?.en || null },
      { name: 'maleDescription', transform: (item: any) => null },
      { name: 'femaleDescription', transform: (item: any) => null },
      { name: 'shipTypeID', transform: (item: any) => item.shipTypeID ?? null },
      'corporationID',
      'perception',
      'willpower',
      'charisma',
      'memory',
      'intelligence',
      'iconID',
      { name: 'shortDescription', transform: (item: any) => item.shortDescription || null },
      { name: 'shortMaleDescription', transform: (item: any) => null },
      { name: 'shortFemaleDescription', transform: (item: any) => null }
    ]
  },
  'chrFactions': {
    files: ['factions.jsonl'],
    fields: [
      { name: 'factionID', transform: (item: any) => item._key },
      { name: 'factionName', transform: (item: any) => item.name?.en || '' },
      { name: 'description', transform: (item: any) => item.description?.en || null },
      { name: 'raceIDs', transform: (item: any) => Array.isArray(item.memberRaces) && item.memberRaces.length > 0 ? item.memberRaces[0] : null },
      'solarSystemID',
      'corporationID',
      'sizeFactor',
      { name: 'stationCount', transform: (item: any) => item.stationCount ?? null },
      { name: 'stationSystemCount', transform: (item: any) => item.stationSystemCount ?? null },
      'militiaCorporationID',
      'iconID'
    ]
  },
  'crpActivities': {
    files: ['corporationActivities.jsonl'],
    fields: [
      { name: 'activityID', transform: (item: any) => item._key },
      { name: 'activityName', transform: (item: any) => item.name?.en || '' },
      { name: 'description', transform: (item: any) => null }
    ]
  },

  'dgmAttributeCategories': {
    files: ['dogmaAttributeCategories.jsonl'],
    fields: [
      { name: 'categoryID', transform: (item) => item._key },
      { name: 'categoryName', transform: (item) => item.name || '' },
      { name: 'categoryDescription', transform: (item) => item.description || null }
    ]
  },
  'dgmAttributeTypes': {
    files: ['dogmaAttributes.jsonl'],
    fields: [
      { name: 'attributeID', transform: (item) => item._key },
      { name: 'attributeName', transform: (item) => item.name || '' },
      'description',
      'iconID',
      'defaultValue',
      'published',
      { name: 'displayName', transform: (item) => null },
      'unitID',
      'stackable',
      'highIsGood',
      { name: 'categoryID', transform: (item) => item.attributeCategoryID ?? null }
    ]
  },
  'dgmEffects': {
    files: ['dogmaEffects.jsonl'],
    fields: [
      { name: 'effectID', transform: (item) => item._key },
      { name: 'effectName', transform: (item) => item.name || null },
      { name: 'effectCategory', transform: (item) => item.effectCategoryID ?? null },
      { name: 'preExpression', transform: (item) => null },
      { name: 'postExpression', transform: (item) => null },
      { name: 'description', transform: (item) => item.description?.en || null },
      'guid',
      { name: 'iconID', transform: (item) => item.iconID ?? null },
      'isOffensive',
      'isAssistance',
      'durationAttributeID',
      'trackingSpeedAttributeID',
      'dischargeAttributeID',
      'rangeAttributeID',
      'falloffAttributeID',
      'disallowAutoRepeat',
      { name: 'published', transform: (item) => item.published ?? false },
      { name: 'displayName', transform: (item) => item.displayName?.en || null },
      'isWarpSafe',
      'rangeChance',
      'electronicChance',
      'propulsionChance',
      'distribution',
      { name: 'sfxName', transform: (item) => null },
      'npcUsageChanceAttributeID',
      'npcActivationChanceAttributeID',
      'fittingUsageChanceAttributeID',
      { name: 'modifierInfo', transform: (item) => {
        if (!item.modifierInfo || !item.modifierInfo.length) return null;
        // Serialize back to the original YAML list format used in the legacy SDE
        return item.modifierInfo.map((m: Record<string, unknown>) => {
          const entries = Object.entries(m);
          return entries.map(([k, v], i) => (i === 0 ? `- ${k}: ${v}` : `  ${k}: ${v}`)).join('\n');
        }).join('\n') + '\n';
      }}
    ]
  },
  'eveGraphics': {
    files: ['graphics.jsonl'],
    fields: [
      { name: 'graphicID', transform: (item) => item._key },
      { name: 'sofFactionName', transform: (item) => null },
      'graphicFile',
      { name: 'sofHullName', transform: (item) => null },
      { name: 'sofRaceName', transform: (item) => null },
      { name: 'description', transform: (item) => null }
    ]
  },
  'eveIcons': {
    files: ['icons.jsonl'],
    fields: [
      { name: 'iconID', transform: (item) => item._key },
      'iconFile',
      { name: 'description', transform: (item) => null }
    ]
  },
  'eveUnits': {
    files: ['dogmaUnits.jsonl'],
    fields: [
      { name: 'unitID', transform: (item) => item._key },
      { name: 'unitName', transform: (item) => item.name || '' },
      { name: 'displayName', transform: (item) => item.displayName?.en || '' },
      { name: 'description', transform: (item) => item.description?.en || null }
    ]
  },
  'crpNPCCorporations': {
    files: ['npcCorporations.jsonl'],
    fields: [
      { name: 'corporationID', transform: (item) => item._key },
      'size',
      'extent',
      { name: 'solarSystemID', transform: (item) => null },
      { name: 'investorID1', transform: (item) => null },
      { name: 'investorShares1', transform: (item) => null },
      { name: 'investorID2', transform: (item) => null },
      { name: 'investorShares2', transform: (item) => null },
      { name: 'investorID3', transform: (item) => null },
      { name: 'investorShares3', transform: (item) => null },
      { name: 'investorID4', transform: (item) => null },
      { name: 'investorShares4', transform: (item) => null },
      { name: 'friendID', transform: (item) => null },
      { name: 'enemyID', transform: (item) => null },
      { name: 'publicShares', transform: (item) => item.shares || null },
      'initialPrice',
      'minSecurity',
      { name: 'scattered', transform: (item) => null },
      { name: 'fringe', transform: (item) => null },
      { name: 'corridor', transform: (item) => null },
      { name: 'hub', transform: (item) => null },
      { name: 'border', transform: (item) => null },
      { name: 'factionID', transform: (item) => null },
      { name: 'sizeFactor', transform: (item) => null },
      { name: 'stationCount', transform: (item) => null },
      { name: 'stationSystemCount', transform: (item) => null },
      { name: 'description', transform: (item) => item.description?.en || null },
      { name: 'iconID', transform: (item) => null }
    ]
  },
  'skinLicense': {
    files: ['skinLicenses.jsonl'],
    fields: [
      'licenseTypeID',
      'duration',
      'skinID'
    ]
  },
  'skinMaterials': {
    files: ['skinMaterials.jsonl'],
    fields: [
      { name: 'skinMaterialID', transform: (item) => item._key },
      { name: 'displayNameID', transform: (item) => null },
      'materialSetID'
    ]
  },
  'skinShip': {
    files: ['skins.jsonl'],
    fields: [
      { name: 'skinID', transform: (item) => item._key },
      { name: 'typeID', transform: (item, subItem) => subItem }
    ],
    expand: 'types'
  },
  'staStations': {
    files: ['npcStations.jsonl'],
    fields: [
      { name: 'stationID', transform: (item) => item._key },
      { name: 'security', transform: (item) => null },
      { name: 'dockingCostPerVolume', transform: (item) => null },
      { name: 'maxShipVolumeDockable', transform: (item) => null },
      { name: 'officeRentalCost', transform: (item) => null },
      'operationID',
      { name: 'stationTypeID', transform: (item) => item.typeID },
      { name: 'corporationID', transform: (item) => item.ownerID },
      'solarSystemID',
      { name: 'constellationID', transform: (item) => null },
      { name: 'regionID', transform: (item) => null },
      { name: 'stationName', transform: (item) => celestialNameCache.get(item._key) || null },
      { name: 'x', transform: (item) => item.position?.x || null },
      { name: 'y', transform: (item) => item.position?.y || null },
      { name: 'z', transform: (item) => item.position?.z || null },
      'reprocessingEfficiency',
      'reprocessingStationsTake',
      'reprocessingHangarFlag'
    ]
  },
  'industryBlueprints': {
    files: ['blueprints.jsonl'],
    fields: [
      { name: 'typeID', transform: (item) => item.blueprintTypeID },
      'maxProductionLimit'
    ]
  },
  'planetSchematics': {
    files: ['planetSchematics.jsonl'],
    fields: [
      { name: 'schematicID', transform: (item) => item._key },
      { name: 'schematicName', transform: (item) => item.name?.en || '' },
      'cycleTime'
    ]
  },
  'planetSchematicsPinMap': {
    files: ['planetSchematics.jsonl'],
    fields: [
      { name: 'schematicID', transform: (item) => item._key },
      { name: 'pinTypeID', transform: (item, subItem) => subItem }
    ],
    expand: 'pins'
  },
  'planetSchematicsTypeMap': {
    files: ['planetSchematics.jsonl'],
    fields: [
      { name: 'schematicID', transform: (item) => item._key },
      { name: 'typeID', transform: (item, subItem) => subItem?._key },
      { name: 'quantity', transform: (item, subItem) => subItem?.quantity },
      { name: 'isInput', transform: (item, subItem) => subItem?.isInput }
    ],
    expand: 'types'
  },
  'mapConstellations': {
    files: ['mapConstellations.jsonl'],
    fields: [
      'regionID',
      { name: 'constellationID', transform: (item) => item._key },
      { name: 'constellationName', transform: (item) => item.name?.en || '' },
      { name: 'x', transform: (item) => item.position?.x || null },
      { name: 'y', transform: (item) => item.position?.y || null },
      { name: 'z', transform: (item) => item.position?.z || null },
      { name: 'xMin', transform: (item) => null },
      { name: 'xMax', transform: (item) => null },
      { name: 'yMin', transform: (item) => null },
      { name: 'yMax', transform: (item) => null },
      { name: 'zMin', transform: (item) => null },
      { name: 'zMax', transform: (item) => null },
      'factionID',
      { name: 'radius', transform: (item) => null }
    ]
  },
  'mapRegions': {
    files: ['mapRegions.jsonl'],
    fields: [
      { name: 'regionID', transform: (item) => item._key },
      { name: 'regionName', transform: (item) => item.name?.en || '' },
      { name: 'x', transform: (item) => item.position?.x || null },
      { name: 'y', transform: (item) => item.position?.y || null },
      { name: 'z', transform: (item) => item.position?.z || null },
      { name: 'xMin', transform: (item) => null },
      { name: 'xMax', transform: (item) => null },
      { name: 'yMin', transform: (item) => null },
      { name: 'yMax', transform: (item) => null },
      { name: 'zMin', transform: (item) => null },
      { name: 'zMax', transform: (item) => null },
      { name: 'factionID', transform: (item) => null },
      { name: 'nebula', transform: (item) => null },
      { name: 'radius', transform: (item) => null }
    ]
  },
  'mapSolarSystems': {
    files: ['mapSolarSystems.jsonl'],
    fields: [
      'regionID',
      'constellationID',
      { name: 'solarSystemID', transform: (item) => item._key },
      { name: 'solarSystemName', transform: (item) => item.name?.en || '' },
      { name: 'x', transform: (item) => item.position?.x || null },
      { name: 'y', transform: (item) => item.position?.y || null },
      { name: 'z', transform: (item) => item.position?.z || null },
      { name: 'xMin', transform: (item) => null },
      { name: 'xMax', transform: (item) => null },
      { name: 'yMin', transform: (item) => null },
      { name: 'yMax', transform: (item) => null },
      { name: 'zMin', transform: (item) => null },
      { name: 'zMax', transform: (item) => null },
      'luminosity',
      'border',
      { name: 'fringe', transform: (item) => item.fringe || false },
      { name: 'corridor', transform: (item) => item.corridor || false },
      { name: 'hub', transform: (item) => item.hub || false },
      'international',
      'regional',
      { name: 'constellation', transform: (item) => item.constellation || false },
      { name: 'security', transform: (item) => item.securityStatus || null },
      { name: 'factionID', transform: (item) => null },
      'radius',
      { name: 'sunTypeID', transform: (item) => item.starID || null },
      'securityClass'
    ]
  },
  'mapLandmarks': {
    files: ['landmarks.jsonl'],
    fields: [
      { name: 'landmarkID', transform: (item) => item._key },
      { name: 'landmarkName', transform: (item) => item.name?.en || '' },
      { name: 'description', transform: (item) => item.description?.en || null },
      { name: 'locationID', transform: (item) => null },
      { name: 'x', transform: (item) => item.position?.x || null },
      { name: 'y', transform: (item) => item.position?.y || null },
      { name: 'z', transform: (item) => item.position?.z || null },
      'iconID'
    ]
  },
  'trnTranslations': {
    files: ['categories.jsonl', 'groups.jsonl', 'types.jsonl', 'metaGroups.jsonl', 'marketGroups.jsonl', 'typeBonus.jsonl', 'mapSolarSystems.jsonl', 'mapConstellations.jsonl', 'mapRegions.jsonl', 'stationOperations.jsonl', 'stationServices.jsonl', 'dogmaUnits.jsonl', 'dogmaEffects.jsonl', 'landmarks.jsonl', 'npcCorporationDivisions.jsonl', 'planetSchematics.jsonl', 'npcCorporations.jsonl'],
    fields: [] // Custom processing in processTable function
  },
  'agtResearchAgents': {
    files: ['npcCharacters.jsonl'],
    fields: [
      { name: 'agentID', transform: (item: any) => item._key },
      { name: 'typeID', transform: (item: any, subItem: any) => subItem?.typeID }
    ],
    expand: 'skills',
    filter: (item: any) => item.agent != null && Array.isArray(item.skills) && item.skills.length > 0
  },
  'crpNPCDivisions': {
    files: ['npcCorporationDivisions.jsonl'],
    fields: [
      { name: 'divisionID', transform: (item: any) => item._key },
      { name: 'divisionName', transform: (item: any) => item.name?.en || '' },
      { name: 'description', transform: (item: any) => item.description?.en || null },
      { name: 'leaderType', transform: (item: any) => item.leaderTypeName?.en || null }
    ]
  },
  'industryActivity': {
    files: ['blueprints.jsonl'],
    fields: [] // Custom processing in processTable function
  },
  'industryActivityMaterials': {
    files: ['blueprints.jsonl'],
    fields: [] // Custom processing in processTable function
  },
  'industryActivityProducts': {
    files: ['blueprints.jsonl'],
    fields: [] // Custom processing in processTable function
  },
  'industryActivityProbabilities': {
    files: ['blueprints.jsonl'],
    fields: [] // Custom processing in processTable function
  },
  'industryActivitySkills': {
    files: ['blueprints.jsonl'],
    fields: [] // Custom processing in processTable function
  },
  'invTraits': {
    files: ['typeBonus.jsonl'],
    fields: [] // Custom processing in processTable function
  },
  'invVolumes': {
    files: ['types.jsonl'],
    fields: [
      { name: 'typeID', transform: (item: any) => item._key },
      'volume'
    ],
    filter: (item: any) => item.volume != null && item.volume !== undefined
  },
  'skins': {
    files: ['skins.jsonl'],
    fields: [
      { name: 'skinID', transform: (item: any) => item._key },
      'internalName',
      'skinMaterialID'
    ]
  },
  'staOperationServices': {
    files: ['stationOperations.jsonl'],
    fields: [
      { name: 'operationID', transform: (item: any) => item._key },
      { name: 'serviceID', transform: (item: any, subItem: any) => subItem }
    ],
    expand: 'services'
  },
  'staOperations': {
    files: ['stationOperations.jsonl'],
    fields: [
      'activityID',
      { name: 'operationID', transform: (item: any) => item._key },
      { name: 'operationName', transform: (item: any) => item.operationName?.en || null },
      { name: 'description', transform: (item: any) => item.description?.en || null },
      { name: 'fringe', transform: (item: any) => item.fringe ?? null },
      { name: 'corridor', transform: (item: any) => item.corridor ?? null },
      { name: 'hub', transform: (item: any) => item.hub ?? null },
      { name: 'border', transform: (item: any) => item.border ?? null },
      { name: 'ratio', transform: (item: any) => item.ratio ?? null },
      { name: 'caldariStationTypeID', transform: (item: any) => item.stationTypes?.find((s: any) => s._key === 1)?._value ?? null },
      { name: 'minmatarStationTypeID', transform: (item: any) => item.stationTypes?.find((s: any) => s._key === 2)?._value ?? null },
      { name: 'amarrStationTypeID', transform: (item: any) => item.stationTypes?.find((s: any) => s._key === 4)?._value ?? null },
      { name: 'gallenteStationTypeID', transform: (item: any) => item.stationTypes?.find((s: any) => s._key === 8)?._value ?? null },
      { name: 'joveStationTypeID', transform: (item: any) => item.stationTypes?.find((s: any) => s._key === 16)?._value ?? null }
    ]
  },
  'staServices': {
    files: ['stationServices.jsonl'],
    fields: [
      { name: 'serviceID', transform: (item: any) => item._key },
      { name: 'serviceName', transform: (item: any) => item.serviceName?.en || '' },
      { name: 'description', transform: (item: any) => null }
    ]
  },
  'trnTranslationLanguages': {
    files: ['translationLanguages.jsonl'],
    fields: [] // Custom processing in processTable function
  },
  'mapJumps': {
    files: ['mapStargates.jsonl'],
    fields: [
      { name: 'stargateID', transform: (item: any) => item._key },
      { name: 'destinationID', transform: (item: any) => item.destination?.stargateID ?? null }
    ]
  },
  'mapSolarSystemJumps': {
    files: ['mapStargates.jsonl'],
    fields: [] // Custom processing in processTable function
  },
  'mapConstellationJumps': {
    files: ['mapStargates.jsonl'],
    fields: [] // Custom processing in processTable function
  },
  'mapRegionJumps': {
    files: ['mapStargates.jsonl'],
    fields: [] // Custom processing in processTable function
  },
  'mapCelestialStatistics': {
    files: ['mapStars.jsonl', 'mapPlanets.jsonl', 'mapMoons.jsonl'],
    fields: [
      { name: 'celestialID', transform: (item: any) => item._key },
      { name: 'temperature', transform: (item: any) => item.statistics?.temperature ?? null },
      { name: 'spectralClass', transform: (item: any) => item.statistics?.spectralClass ?? null },
      { name: 'luminosity', transform: (item: any) => item.statistics?.luminosity ?? null },
      { name: 'age', transform: (item: any) => item.statistics?.age ?? null },
      { name: 'life', transform: (item: any) => item.statistics?.life ?? null },
      { name: 'orbitRadius', transform: (item: any) => item.statistics?.orbitRadius ?? null },
      { name: 'eccentricity', transform: (item: any) => item.statistics?.eccentricity ?? null },
      { name: 'massDust', transform: (item: any) => item.statistics?.massDust ?? null },
      { name: 'massGas', transform: (item: any) => item.statistics?.massGas ?? null },
      { name: 'fragmented', transform: (item: any) => item.statistics?.fragmented ?? null },
      { name: 'density', transform: (item: any) => item.statistics?.density ?? null },
      { name: 'surfaceGravity', transform: (item: any) => item.statistics?.surfaceGravity ?? null },
      { name: 'escapeVelocity', transform: (item: any) => item.statistics?.escapeVelocity ?? null },
      { name: 'orbitPeriod', transform: (item: any) => item.statistics?.orbitPeriod ?? null },
      { name: 'rotationRate', transform: (item: any) => item.statistics?.rotationRate ?? null },
      { name: 'locked', transform: (item: any) => item.statistics?.locked ?? null },
      { name: 'pressure', transform: (item: any) => item.statistics?.pressure ?? null },
      { name: 'radius', transform: (item: any) => item.radius ?? null },
      { name: 'mass', transform: (item: any) => null }
    ],
    filter: (item: any) => item.statistics != null
  },
  'mapCelestialGraphics': {
    files: ['mapPlanets.jsonl', 'mapMoons.jsonl'],
    fields: [
      { name: 'celestialID', transform: (item: any) => item._key },
      { name: 'heightMap1', transform: (item: any) => item.attributes?.heightMap1 ?? null },
      { name: 'heightMap2', transform: (item: any) => item.attributes?.heightMap2 ?? null },
      { name: 'shaderPreset', transform: (item: any) => item.attributes?.shaderPreset ?? null },
      { name: 'population', transform: (item: any) => item.attributes?.population != null ? (item.attributes.population ? 1 : 0) : null }
    ],
    filter: (item: any) => item.attributes != null
  },
};

function convertToRoman(num: number): string {
  if (num <= 0 || num > 3999) throw new Error('Number out of range (must be 1-3999)');

  const lookup = {
    M: 1000, CM: 900, D: 500, CD: 400,
    C: 100, XC: 90, L: 50, XL: 40,
    X: 10, IX: 9, V: 5, IV: 4, I: 1
  };
  
  let roman = '';
  for (const i in lookup) {
    const key = i as keyof typeof lookup;
    while (num >= lookup[key]) {
      roman += key;
      num -= lookup[key];
    }
  }
  return roman;
}

