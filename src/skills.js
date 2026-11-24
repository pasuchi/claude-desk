// Skills: carpetas con un SKILL.md (frontmatter `name` y `description`) más
// archivos de apoyo opcionales. Siguen el formato de Agent Skills de Anthropic.
// Claude ve el nombre y la descripción de cada skill activa y carga el resto
// bajo demanda con las herramientas `use_skill` y `read_skill_file`.
const fs = require('fs');
const path = require('path');

function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

function slug(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'skill';
}

function listSkills(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const md = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(md)) continue;
    const { meta, body } = parseFrontmatter(fs.readFileSync(md, 'utf8'));
    out.push({
      folder: entry.name,
      name: meta.name || entry.name,
      description: meta.description || '',
      body,
      files: listFiles(path.join(dir, entry.name)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function listFiles(root, rel = '') {
  const res = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(rel, e.name);
    if (e.isDirectory()) res.push(...listFiles(root, p));
    else res.push(p);
  }
  return res;
}

function saveSkill(dir, { folder, name, description, body }) {
  const target = folder || slug(name);
  const skillDir = path.join(dir, target);
  fs.mkdirSync(skillDir, { recursive: true });
  const safeDesc = String(description || '').replace(/\n/g, ' ');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${safeDesc}\n---\n\n${body || ''}`);
  return target;
}

function deleteSkill(dir, folder) {
  const p = path.resolve(dir, folder);
  if (path.dirname(p) !== path.resolve(dir)) throw new Error('Ruta de skill no válida');
  fs.rmSync(p, { recursive: true, force: true });
}

function importSkill(dir, srcFolder) {
  if (!fs.existsSync(path.join(srcFolder, 'SKILL.md'))) throw new Error('La carpeta no contiene un SKILL.md');
  const target = path.join(dir, slug(path.basename(srcFolder)));
  fs.cpSync(srcFolder, target, { recursive: true });
  return path.basename(target);
}

// Bloque para el system prompt + herramientas para un conjunto de skills activas.
function skillTooling(dir, enabledFolders) {
  const all = listSkills(dir).filter((s) => enabledFolders.includes(s.folder));
  if (!all.length) return { prompt: '', tools: [], handle: null };
  const prompt =
    '\n\n# Skills disponibles\nTienes estas skills. Cuando una sea relevante para la tarea, llama primero a `use_skill` con su nombre para leer sus instrucciones completas y síguelas.\n' +
    all.map((s) => `- **${s.folder}**: ${s.description}`).join('\n');
  const names = all.map((s) => s.folder);
  const tools = [
    {
      name: 'use_skill',
      description: 'Carga las instrucciones completas (SKILL.md) de una skill y la lista de sus archivos de apoyo.',
      input_schema: { type: 'object', properties: { name: { type: 'string', enum: names } }, required: ['name'], additionalProperties: false },
    },
    {
      name: 'read_skill_file',
      description: 'Lee un archivo de apoyo dentro de la carpeta de una skill (ruta relativa a la skill).',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string', enum: names }, path: { type: 'string' } },
        required: ['name', 'path'],
        additionalProperties: false,
      },
    },
  ];
  const handle = (toolName, input) => {
    const skill = all.find((s) => s.folder === input?.name);
    if (!skill) return { text: `Skill desconocida: ${input?.name}`, isError: true };
    if (toolName === 'use_skill') {
      return { text: `${skill.body}\n\n---\nArchivos de la skill: ${skill.files.join(', ')}` };
    }
    const root = path.resolve(dir, skill.folder);
    const p = path.resolve(root, String(input.path || ''));
    if (!p.startsWith(root + path.sep)) return { text: 'Ruta fuera de la skill', isError: true };
    if (!fs.existsSync(p)) return { text: 'Archivo no encontrado', isError: true };
    return { text: fs.readFileSync(p, 'utf8').slice(0, 200000) };
  };
  return { prompt, tools, handle };
}

module.exports = { listSkills, saveSkill, deleteSkill, importSkill, skillTooling, parseFrontmatter };
