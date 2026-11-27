import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const REPO_CARD_TYPES = Object.freeze([
  'overview',
  'architecture_design',
  'tech_stack',
  'coding_conventions',
  'unique_setup_and_commands',
  'configuration_system',
  'dependency_management',
  'logging_system',
  'error_handling',
  'build_system',
  'frontend_style',
])

const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '.idea', '.vscode', '.superagent', '__pycache__',
  '.venv', 'venv', 'vendor', 'tmp', 'temp',
])
const SECRET_NAMES = /^(?:\.env(?:\..*)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials(?:\.json)?|secrets?\.(?:json|ya?ml))$/i
const SECRET_EXT = /\.(?:pem|key|p12|pfx|keystore)$/i
const MAX_FILE_BYTES = 512 * 1024
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.py', '.go', '.rs', '.java',
  '.kt', '.kts', '.scala', '.rb', '.php', '.cs', '.fs', '.fsx', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.swift', '.m', '.mm', '.lua', '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.dart',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.sql', '.sh', '.bash', '.zsh', '.ps1',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.xml',
  '.md', '.markdown', '.txt', '.rst', '.adoc',
])
const MANIFEST_NAMES = new Set([
  'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'pyproject.toml', 'requirements.txt',
  'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'Gemfile', 'composer.json', 'Dockerfile', 'Makefile', 'README.md', 'README', 'tsconfig.json',
  'eslint.config.js', '.eslintrc', '.eslintrc.json', '.prettierrc', '.prettierrc.json', 'prettier.config.js',
])
const LANGUAGE_BY_EXT = Object.freeze({
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.vue': 'Vue', '.svelte': 'Svelte',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#', '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++',
  '.hpp': 'C++', '.swift': 'Swift', '.dart': 'Dart', '.sql': 'SQL', '.sh': 'Shell',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.md': 'Markdown', '.json': 'JSON',
  '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
})
const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.py', '.go', '.rs', '.java',
  '.kt', '.kts', '.rb', '.php', '.cs', '.c', '.h', '.cc', '.cpp', '.hpp', '.swift', '.dart',
])

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function slash(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
}

function relativePath(root, file) {
  return slash(path.relative(root, file))
}

function moduleSlug(relativeDir) {
  const clean = slash(relativeDir).replace(/^\/+|\/+$/g, '')
  if (!clean) return '/'
  return `/${clean.split('/').map(part => part.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')).filter(Boolean).join('/')}`
}

function moduleTitle(relativeDir, projectTitle) {
  const clean = slash(relativeDir)
  if (!clean) return projectTitle
  return clean.split('/').at(-1) || projectTitle
}

function lineOf(content, pattern, fallback = 1) {
  const match = pattern.exec(content)
  if (!match) return fallback
  return content.slice(0, match.index).split('\n').length
}

function sourceOf(file, lineStart = 1, lineEnd = Math.min(lineStart + 40, file.lineCount || lineStart)) {
  return { path: file.relative, lineStart, lineEnd }
}

function uniqueSources(files, limit = 8) {
  const seen = new Set()
  const result = []
  for (const file of files) {
    if (!file || seen.has(file.relative)) continue
    seen.add(file.relative)
    result.push(sourceOf(file))
    if (result.length >= limit) break
  }
  return result
}

function parseJson(content) {
  try { return JSON.parse(content) } catch { return null }
}

function packageScripts(pkg) {
  if (!isRecord(pkg?.scripts)) return []
  return Object.entries(pkg.scripts)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([name, command]) => ({ name, command: command.trim() }))
}

function dependenciesOf(pkg) {
  const result = []
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!isRecord(pkg?.[field])) continue
    for (const [name, version] of Object.entries(pkg[field])) result.push({ name, version: String(version), field })
  }
  return result
}

function detectLanguages(files) {
  const counts = new Map()
  for (const file of files) {
    const language = file.language
    if (!language) continue
    counts.set(language, (counts.get(language) ?? 0) + 1)
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

function detectEnvNames(files) {
  const names = new Set()
  for (const file of files) {
    for (const match of file.content.matchAll(/process\.env\.([A-Z][A-Z0-9_]{1,80})|os\.environ\[['"]([A-Z][A-Z0-9_]{1,80})['"]\]/g)) {
      names.add(match[1] ?? match[2])
    }
  }
  return [...names].sort()
}

function detectImports(file) {
  const imports = []
  const patterns = [
    /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*from\s+([.\w]+)\s+import\s+/gm,
    /^\s*import\s+([.\w]+)(?:\s|,|$)/gm,
    /^\s*use\s+([\w]+)(?:::|;)/gm,
    /^\s*import\s+([\w.]+);/gm,
  ]
  for (const pattern of patterns) {
    for (const match of file.content.matchAll(pattern)) {
      const value = match[1]
      if (value && !imports.includes(value)) imports.push(value)
    }
  }
  return imports
}

function resolveImport(root, file, specifier) {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(path.join(root, file.relative)), specifier)
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}.tsx`, `${base}.py`,
    path.join(base, 'index.js'), path.join(base, 'index.ts'), path.join(base, 'index.tsx'), path.join(base, 'mod.rs')]
  return candidates.map(candidate => slash(path.relative(root, candidate))).find(candidate => !candidate.startsWith('../')) ?? null
}

async function walkRepository(root, options) {
  const files = []
  let truncated = false
  let totalBytes = 0
  async function visit(directory, depth) {
    if (truncated || depth > options.maxDepth) return
    let entries
    try { entries = await fsp.readdir(directory, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (truncated) return
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name.toLowerCase())) continue
        await visit(absolute, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const relative = relativePath(root, absolute)
      const ext = path.extname(entry.name).toLowerCase()
      const manifest = MANIFEST_NAMES.has(entry.name)
      if (!manifest && !TEXT_EXTENSIONS.has(ext)) continue
      if (SECRET_NAMES.test(entry.name) || SECRET_EXT.test(entry.name)) continue
      let stat
      try { stat = await fsp.stat(absolute) } catch { continue }
      if (stat.size > MAX_FILE_BYTES) continue
      if (files.length >= options.maxFiles || totalBytes + stat.size > options.maxBytes) {
        truncated = true
        return
      }
      let buffer
      try { buffer = await fsp.readFile(absolute) } catch { continue }
      if (buffer.includes(0)) continue
      totalBytes += buffer.length
      const content = buffer.toString('utf8')
      files.push({
        absolute,
        relative,
        name: entry.name,
        ext,
        language: LANGUAGE_BY_EXT[ext] ?? null,
        size: buffer.length,
        mtimeMs: stat.mtimeMs,
        content,
        lineCount: content ? content.split('\n').length : 1,
        hash: createHash('sha256').update(buffer).digest('hex'),
      })
    }
  }
  await visit(root, 0)
  return { files, truncated, totalBytes }
}

function fingerprintFiles(files) {
  const hash = createHash('sha256')
  for (const file of files) hash.update(`${file.relative}\0${file.size}\0${file.mtimeMs}\0${file.hash}\n`)
  return hash.digest('hex')
}

async function gitHead(root) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, timeout: 5000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

function buildCards(module, context) {
  const { files, projectTitle, pkg, readme, allFiles } = context
  const own = files.filter(file => module.relativeDir ? file.relative.startsWith(`${module.relativeDir}/`) : true)
  const sourceFiles = own.filter(file => SOURCE_EXTENSIONS.has(file.ext))
  const manifests = own.filter(file => MANIFEST_NAMES.has(file.name))
  const packageFile = own.find(file => file.name === 'package.json')
  const modulePkg = packageFile ? parseJson(packageFile.content) : pkg
  const scripts = packageScripts(modulePkg)
  const dependencies = dependenciesOf(modulePkg)
  const languages = detectLanguages(own)
  const primaryLanguage = Object.keys(languages)[0] ?? '未识别语言'
  const readmeFile = own.find(file => /^readme(?:\.md)?$/i.test(file.name))
  const description = typeof modulePkg?.description === 'string' && modulePkg.description.trim()
    ? modulePkg.description.trim()
    : readmeFile
      ? readmeFile.content.split(/\r?\n/).map(line => line.replace(/^#\s*/, '').trim()).find(Boolean) ?? ''
      : ''
  const entryFiles = sourceFiles.filter(file => /(?:^|\/)(?:index|main|app|server|cli)(?:\.[^/]+)?$/i.test(file.relative)).slice(0, 6)
  const overviewSources = uniqueSources([...entryFiles, packageFile, readmeFile].filter(Boolean), 6)
  const overview = [
    description || `${module.title} 包含 ${own.length} 个纳入扫描的文件，主要使用 ${primaryLanguage}。`,
    '',
    `- 模块路径：${module.slug}`,
    `- 文件数：${own.length}`,
    `- 主要语言：${primaryLanguage}`,
    entryFiles.length ? `- 入口文件：${entryFiles.map(file => file.relative).join('、')}` : '- 入口文件：未检测到',
  ].join('\n')

  const depends = module.depends_on ?? []
  const architecture = [
    `## 职责`,
    description || `${module.title} 的代码集中在 ${module.relativeDir || '仓库根目录'}，通过入口文件对外提供能力。`,
    '',
    '## 入口',
    entryFiles.length ? entryFiles.map(file => `- ${file.relative}`).join('\n') : '- 未检测到明确入口。',
    '',
    '## 依赖',
    depends.length ? depends.slice(0, 12).map(item => `- ${item.target}：${item.reason}`).join('\n') : '- 未检测到模块间依赖。',
  ].join('\n')

  const techStack = [
    '## 语言',
    Object.keys(languages).length ? Object.entries(languages).map(([name, count]) => `- ${name}：${count} 个文件`).join('\n') : '- 未检测到源码语言。',
    '',
    '## 直接依赖',
    dependencies.length ? dependencies.slice(0, 20).map(item => `- ${item.name}@${item.version}（${item.field}）`).join('\n') : '- 未检测到包依赖。',
  ].join('\n')

  const conventionFiles = own.filter(file => /eslint|prettier|tsconfig|editorconfig|ruff|black|biome/i.test(file.name))
  const conventions = [
    ...(conventionFiles.length ? conventionFiles.slice(0, 8).map(file => `- 检测到 ${file.relative}，遵循其中的格式与静态检查规则。`) : []),
    ...(scripts.some(item => /lint|format|typecheck/i.test(item.name)) ? ['- 包脚本定义了 lint、format 或 typecheck 命令，修改后应运行对应脚本。'] : []),
    ...(entryFiles.length ? ['- 新增能力优先从现有入口文件导出，避免建立平行入口。'] : []),
    '- 未检测到更具体的命名或注释约定；不要凭空推断。',
  ].join('\n')

  const setup = [
    ...scripts.map(item => `- \`${item.name}\`: ${item.command}`),
    ...(own.some(file => file.name === 'Makefile') ? ['- 仓库提供 Makefile；先查看 targets 再执行构建。'] : []),
    ...(readmeFile ? ['- 安装与运行步骤以 README 为准。'] : []),
    '- 未检测到额外搭建命令。',
  ].join('\n')

  const configFiles = own.filter(file => /(?:config|settings|\.env\.example|docker-compose|Dockerfile)/i.test(file.name))
  const envNames = detectEnvNames(sourceFiles)
  const configuration = [
    '## 配置文件',
    configFiles.length ? configFiles.slice(0, 12).map(file => `- ${file.relative}`).join('\n') : '- 未检测到明确配置文件。',
    '',
    '## 环境变量名称',
    envNames.length ? envNames.slice(0, 30).map(name => `- ${name}`).join('\n') : '- 未检测到环境变量名称；这里不会记录任何值。',
  ].join('\n')

  const lockFiles = own.filter(file => /(?:lock|Cargo\.lock|go\.sum)/i.test(file.name))
  const dependencyManagement = [
    '## 清单与锁文件',
    [...manifests.filter(file => /package\.json|pyproject|requirements|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|Gemfile|composer\.json/i.test(file.name)), ...lockFiles]
      .slice(0, 12).map(file => `- ${file.relative}`).join('\n') || '- 未检测到依赖清单。',
    '',
    '## 规则',
    dependencies.length ? '- 修改依赖时同步更新对应清单与锁文件。' : '- 当前模块未声明包依赖。',
  ].join('\n')

  const loggingFiles = sourceFiles.filter(file => /(?:logger|logging|log\.(?:info|warn|error|debug)|console\.log)/i.test(file.content)).slice(0, 12)
  const logging = loggingFiles.length
    ? loggingFiles.map(file => `- ${file.relative} 包含日志调用或 logger 引用。`).join('\n')
    : '- 未检测到日志框架或日志调用。'

  const errorFiles = sourceFiles.filter(file => /(?:try\s*\{|catch\s*\(|Result<|Err\(|Exception|error class)/i.test(file.content)).slice(0, 12)
  const errorHandling = errorFiles.length
    ? errorFiles.map(file => `- ${file.relative} 包含异常处理或错误类型模式。`).join('\n')
    : '- 未检测到明确错误处理模式。'

  const buildFiles = own.filter(file => /Dockerfile|Makefile|\.github\/workflows|vite\.config|webpack|rollup|esbuild|tsup|CMakeLists/i.test(file.relative))
  const build = [
    ...scripts.filter(item => /build|compile|bundle|package/i.test(item.name)).map(item => `- \`${item.name}\`: ${item.command}`),
    ...buildFiles.slice(0, 10).map(file => `- 构建配置文件：${file.relative}`),
    '- 未检测到额外构建系统。',
  ].join('\n')

  const uiFiles = own.filter(file => /\.(?:jsx|tsx|vue|svelte|css|scss|sass|less|html)$/i.test(file.ext))
  const frameworks = [...new Set(uiFiles.flatMap(file => {
    const found = []
    if (/from\s+['"]react['"]|require\(['"]react['"]\)/.test(file.content)) found.push('React')
    if (/from\s+['"]vue['"]/.test(file.content)) found.push('Vue')
    if (/from\s+['"]svelte/.test(file.content)) found.push('Svelte')
    return found
  }))]
  const frontendStyle = [
    frameworks.length ? `- UI 框架：${frameworks.join('、')}` : '- 未检测到 React/Vue/Svelte 框架引用。',
    uiFiles.length ? `- UI 文件：${uiFiles.slice(0, 12).map(file => file.relative).join('、')}` : '- 未检测到前端样式或组件文件。',
    '- 样式约定以现有组件和样式文件为准。',
  ].join('\n')

  return {
    overview: { body: overview, sources: overviewSources },
    architecture_design: { body: architecture, sources: uniqueSources([...entryFiles, ...sourceFiles], 8) },
    tech_stack: { body: techStack, sources: uniqueSources([packageFile, ...manifests], 6) },
    coding_conventions: { body: conventions, sources: uniqueSources(conventionFiles, 6) },
    unique_setup_and_commands: { body: setup, sources: uniqueSources([packageFile, readmeFile, ...own.filter(file => file.name === 'Makefile')].filter(Boolean), 6) },
    configuration_system: { body: configuration, sources: uniqueSources(configFiles, 8) },
    dependency_management: { body: dependencyManagement, sources: uniqueSources([packageFile, ...lockFiles].filter(Boolean), 8) },
    logging_system: { body: logging, sources: uniqueSources(loggingFiles, 8) },
    error_handling: { body: errorHandling, sources: uniqueSources(errorFiles, 8) },
    build_system: { body: build, sources: uniqueSources(buildFiles, 8) },
    frontend_style: { body: frontendStyle, sources: uniqueSources(uiFiles, 8) },
  }
}

function buildSnapshot({ root, projectId, projectTitle, head, fingerprint, files, truncated, totalBytes, previous }) {
  const directories = new Set([''])
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(file.ext)) continue
    let dir = path.posix.dirname(file.relative)
    while (dir && dir !== '.') {
      directories.add(dir)
      dir = path.posix.dirname(dir)
    }
  }
  const sortedDirs = [...directories].sort((a, b) => a === '' ? -1 : b === '' ? 1 : a.split('/').length - b.split('/').length || a.localeCompare(b))
  const pkgFile = files.find(file => file.relative === 'package.json')
  const pkg = pkgFile ? parseJson(pkgFile.content) : null
  const readme = files.find(file => /^readme(?:\.md)?$/i.test(file.relative))?.content ?? ''
  const context = { projectTitle, pkg, readme, allFiles: files }
  const modules = sortedDirs.slice(0, 250).map(relativeDir => {
    const slug = moduleSlug(relativeDir)
    const own = files.filter(file => relativeDir ? file.relative.startsWith(`${relativeDir}/`) : true)
    const module = { slug, path: relativeDir, relativeDir, title: moduleTitle(relativeDir, projectTitle), kind: relativeDir ? 'directory' : 'repository',
      summary: '', files: own.length, languages: detectLanguages(own), cards: {}, sources: uniqueSources(own, 6),
      depends_on: [], related_to: [] }
    const cardEntries = buildCards(module, { ...context, files: own })
    module.cards = Object.fromEntries(REPO_CARD_TYPES.map(type => [type, cardEntries[type].body]))
    module.cardSources = Object.fromEntries(REPO_CARD_TYPES.map(type => [type, cardEntries[type].sources]))
    module.summary = cardEntries.overview.body.split('\n')[0]
    return module
  })
  const bySlug = new Map(modules.map(module => [module.slug, module]))
  const fileToModule = new Map()
  for (const module of modules) {
    for (const file of files) {
      if (module.relativeDir && file.relative.startsWith(`${module.relativeDir}/`)) {
        const current = fileToModule.get(file.relative)
        if (!current || module.relativeDir.length > current.relativeDir.length) fileToModule.set(file.relative, module)
      } else if (!module.relativeDir && !fileToModule.has(file.relative)) fileToModule.set(file.relative, module)
    }
  }
  for (const module of modules) {
    const own = files.filter(file => module.relativeDir ? file.relative.startsWith(`${module.relativeDir}/`) : true)
    for (const file of own) {
      for (const specifier of detectImports(file)) {
        const resolved = resolveImport(root, file, specifier)
        const target = resolved ? fileToModule.get(resolved) : null
        if (!target || target.slug === module.slug || target.slug === '/') continue
        if (!module.depends_on.some(item => item.target === target.slug)) {
          module.depends_on.push({ target: target.slug, reason: `${file.relative} 引用了 ${specifier}`, origin: 'import' })
        }
      }
    }
    module.depends_on = module.depends_on.slice(0, 30)
  }
  for (const module of modules) {
    if (module.slug === '/') continue
    const siblings = modules.filter(candidate => candidate.slug !== '/' && candidate.slug !== module.slug
      && path.posix.dirname(candidate.slug) === path.posix.dirname(module.slug)).slice(0, 3)
    for (const sibling of siblings) {
      if (!module.related_to.some(item => item.target === sibling.slug)) {
        module.related_to.push({ target: sibling.slug, reason: '同属一个目录边界', origin: 'layout' })
      }
    }
  }
  if (previous?.modules) {
    for (const module of modules) {
      const old = previous.modules.find(item => item.slug === module.slug)
      for (const kind of ['depends_on', 'related_to']) {
        for (const relation of old?.[kind] ?? []) {
          if (relation.origin !== 'manual') continue
          module[kind] = (module[kind] ?? []).filter(item => item.target !== relation.target)
          module[kind].push({ ...relation, origin: 'manual' })
        }
      }
    }
  }
  for (const module of modules) {
    const dependencyLines = module.depends_on.length
      ? module.depends_on.slice(0, 12).map(item => `- ${item.target}：${item.reason}`).join('\n')
      : '- 未检测到模块间依赖。'
    module.cards.architecture_design = module.cards.architecture_design.includes('## 依赖')
      ? module.cards.architecture_design.replace(/## 依赖[\s\S]*$/, `## 依赖\n${dependencyLines}`)
      : `${module.cards.architecture_design}\n\n## 依赖\n${dependencyLines}`
  }
  const repository = modules.find(module => module.slug === '/')
  const stats = { files: files.length, modules: Math.max(0, modules.length - 1), bytes: totalBytes,
    languages: detectLanguages(files), truncated }
  const wiki = buildWiki({ projectTitle, stats, modules, repository })
  return { schemaVersion: 1, projectPath: root, projectId, title: projectTitle, generatedAt: new Date().toISOString(),
    baseline: { fingerprint, head }, stats, repository, modules: modules.filter(module => module.slug !== '/'), wiki }
}

function buildWiki({ projectTitle, stats, modules, repository }) {
  const top = modules.filter(module => module.slug !== '/').slice(0, 20)
  const edges = modules.flatMap(module => (module.depends_on ?? []).map(item => ({ source: module.slug, ...item }))).slice(0, 80)
  const overview = [
    `# ${projectTitle}`,
    '',
    repository?.summary ?? '仓库 ontology 已生成。',
    '',
    `- 扫描文件：${stats.files}`,
    `- 模块：${stats.modules}`,
    `- 语言：${Object.keys(stats.languages).join('、') || '未识别'}`,
    `- 扫描截断：${stats.truncated ? '是' : '否'}`,
    '',
    '## 主要模块',
    top.length ? top.map(module => `- ${module.title}（${module.slug}）：${module.summary}`).join('\n') : '- 未识别到源码模块。',
  ].join('\n')
  const architecture = [
    '# 架构总览',
    '',
    '```mermaid',
    'graph TD',
    ...top.map((module, index) => `  M${index}["${module.title.replaceAll('"', "'")}"]`),
    ...edges.map(edge => {
      const source = top.findIndex(module => module.slug === edge.source)
      const target = top.findIndex(module => module.slug === edge.target)
      return source >= 0 && target >= 0 ? `  M${source} --> M${target}` : null
    }).filter(Boolean),
    '```',
    '',
    edges.length ? edges.map(edge => `- ${edge.source} → ${edge.target}：${edge.reason}`).join('\n') : '- 未检测到模块间依赖。',
  ].join('\n')
  const modulesPage = ['# 模块清单', '', ...top.flatMap(module => [
    `## ${module.title}`, '',
    `- 路径：${module.slug}`,
    `- 文件：${module.files}`,
    `- 依赖：${(module.depends_on ?? []).map(item => item.target).join('、') || '无'}`,
    '', module.summary, '',
  ])].join('\n')
  const dependencies = ['# 依赖关系', '', ...edges.map(edge => `- ${edge.source} → ${edge.target}：${edge.reason}`)].join('\n')
  const conventions = ['# 编码约定', '', repository?.cards.coding_conventions ?? '- 未检测到编码约定。'].join('\n')
  const setup = ['# 搭建与命令', '', repository?.cards.unique_setup_and_commands ?? '- 未检测到搭建命令。'].join('\n')
  return [
    { path: '/overview', title: '项目概览', body: overview, sources: repository?.sources ?? [] },
    { path: '/architecture', title: '架构总览', body: architecture, sources: repository?.sources ?? [] },
    { path: '/modules', title: '模块清单', body: modulesPage, sources: top.flatMap(module => module.sources ?? []).slice(0, 12) },
    { path: '/dependencies', title: '依赖关系', body: dependencies, sources: top.flatMap(module => module.sources ?? []).slice(0, 12) },
    { path: '/conventions', title: '编码约定', body: conventions, sources: repository?.cardSources?.coding_conventions ?? [] },
    { path: '/setup', title: '搭建与命令', body: setup, sources: repository?.cardSources?.unique_setup_and_commands ?? [] },
  ]
}

async function replaceFile(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(temporary, file)
}

export function createRepoWiki(options = {}) {
  if (!isRecord(options)) throw new TypeError('repo wiki options must be an object')
  const stateDir = path.resolve(String(options.stateDir ?? ''))
  if (!options.stateDir) fail('INVALID_OPTIONS', 'repo wiki requires stateDir')
  const maxFiles = Math.max(100, Math.min(20_000, Number(options.maxFiles) || 4000))
  const maxBytes = Math.max(1024 * 1024, Math.min(64 * 1024 * 1024, Number(options.maxBytes) || 8 * 1024 * 1024))
  const maxDepth = Math.max(1, Math.min(16, Number(options.maxDepth) || 8))
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  const directory = path.join(stateDir, 'repo-wiki')
  const fileFor = projectId => path.join(directory, `${projectId}.json`)

  async function rootOf(projectPath) {
    if (typeof projectPath !== 'string' || !projectPath.trim()) fail('INVALID_PROJECT', 'projectPath must be a nonempty absolute path')
    if (!path.isAbsolute(projectPath)) fail('INVALID_PROJECT', 'projectPath must be absolute')
    let root
    try { root = await fsp.realpath(path.resolve(projectPath)) } catch { fail('PROJECT_NOT_FOUND', 'projectPath does not exist') }
    const stat = await fsp.stat(root)
    if (!stat.isDirectory()) fail('INVALID_PROJECT', 'projectPath must be a directory')
    return root
  }

  async function readProject(projectPath) {
    const root = await rootOf(projectPath)
    const projectId = createHash('sha256').update(root).digest('hex')
    const file = fileFor(projectId)
    let snapshot
    try { snapshot = JSON.parse(await fsp.readFile(file, 'utf8')) } catch (error) {
      if (error?.code === 'ENOENT') return { root, projectId, file, snapshot: null }
      fail('CORRUPT_STORE', `repository ontology store is not valid JSON: ${error.message}`)
    }
    if (snapshot?.schemaVersion !== 1 || snapshot.projectPath !== root) fail('CORRUPT_STORE', 'repository ontology store has an unsupported shape')
    return { root, projectId, file, snapshot }
  }

  async function generate(projectPath, generateOptions = {}) {
    const root = await rootOf(projectPath)
    const projectId = createHash('sha256').update(root).digest('hex')
    const file = fileFor(projectId)
    let previous = null
    try { previous = JSON.parse(await fsp.readFile(file, 'utf8')) } catch (error) {
      if (error?.code !== 'ENOENT') fail('CORRUPT_STORE', `repository ontology store is not valid JSON: ${error.message}`)
    }
    const walked = await walkRepository(root, { maxFiles, maxBytes, maxDepth })
    const fingerprint = fingerprintFiles(walked.files)
    if (!generateOptions.force && previous?.baseline?.fingerprint === fingerprint) return previous
    const pkgFile = walked.files.find(item => item.relative === 'package.json')
    const pkg = pkgFile ? parseJson(pkgFile.content) : null
    const projectTitle = typeof pkg?.name === 'string' && pkg.name.trim() ? pkg.name.trim() : path.basename(root)
    const snapshot = buildSnapshot({ root, projectId, projectTitle, head: await gitHead(root), fingerprint,
      files: walked.files, truncated: walked.truncated, totalBytes: walked.totalBytes, previous })
    await replaceFile(file, snapshot)
    return snapshot
  }

  async function status(projectPath) {
    return (await readProject(projectPath)).snapshot
  }

  async function list(projectPath, listOptions = {}) {
    const { snapshot } = await readProject(projectPath)
    if (!snapshot) return { projectPath: snapshot?.projectPath ?? path.resolve(projectPath), projectId: null, path: listOptions.path ?? '/', modules: [], repository: null }
    const prefix = listOptions.path && listOptions.path !== '/' ? listOptions.path.replace(/\/$/, '') : ''
    const modules = snapshot.modules.filter(module => !prefix || module.slug === prefix || module.slug.startsWith(`${prefix}/`))
    return { projectPath: snapshot.projectPath, projectId: snapshot.projectId, path: listOptions.path ?? '/', modules, repository: snapshot.repository }
  }

  async function read(projectPath, readOptions = {}) {
    const { snapshot } = await readProject(projectPath)
    if (!snapshot) fail('NOT_FOUND', 'repository ontology has not been generated')
    const requested = String(readOptions.path ?? '').trim()
    const cardType = REPO_CARD_TYPES.find(type => requested === `/${type}` || requested.endsWith(`/${type}`))
    if (!cardType) fail('INVALID_CARD', 'path must end with a supported cardType')
    const modulePath = requested === `/${cardType}` ? '/' : requested.slice(0, -(cardType.length + 1))
    const module = modulePath === '/' ? snapshot.repository : snapshot.modules.find(item => item.slug === modulePath)
    if (!module) fail('NOT_FOUND', `unknown module: ${modulePath}`)
    const body = module.cards?.[cardType]
    if (typeof body !== 'string') fail('NOT_FOUND', `module has no ${cardType} card`)
    return { path: requested, modulePath, cardType, title: `${module.title} · ${cardType}`, body,
      sources: module.cardSources?.[cardType] ?? module.sources ?? [], updatedAt: snapshot.generatedAt }
  }

  async function query(projectPath, queryOptions = {}) {
    const { snapshot } = await readProject(projectPath)
    if (!snapshot) return { query: queryOptions.query ?? '', matches: [] }
    const terms = String(queryOptions.query ?? '').toLowerCase().split(/\s+/).map(term => term.trim()).filter(Boolean)
    const limit = Math.max(1, Math.min(50, Number(queryOptions.limit) || 8))
    const matches = []
    for (const module of [snapshot.repository, ...snapshot.modules].filter(Boolean)) {
      for (const cardType of REPO_CARD_TYPES) {
        const body = module.cards?.[cardType] ?? ''
        const sourceText = (module.sources ?? []).map(source => source.path).join(' ')
        const haystack = `${module.title} ${module.summary} ${sourceText} ${body}`.toLowerCase()
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0) + (module.slug === '/' ? 0.1 : 0)
        if (terms.length && score <= (module.slug === '/' ? 0.1 : 0)) continue
        const first = terms.map(term => body.toLowerCase().indexOf(term)).find(index => index >= 0) ?? 0
        const start = Math.max(0, first - 80)
        const snippet = body.slice(start, start + 240).replace(/\s+/g, ' ').trim()
        matches.push({ modulePath: module.slug, title: module.title, summary: module.summary, cardType,
          snippet, sources: module.cardSources?.[cardType] ?? module.sources ?? [], score })
      }
    }
    matches.sort((a, b) => b.score - a.score || a.modulePath.localeCompare(b.modulePath) || a.cardType.localeCompare(b.cardType))
    return { query: queryOptions.query ?? '', matches: matches.slice(0, limit) }
  }

  async function mutateRelation(projectPath, input, remove = false) {
    const { snapshot, file } = await readProject(projectPath)
    if (!snapshot) fail('NOT_FOUND', 'repository ontology has not been generated')
    const sourcePath = String(input.sourcePath ?? '').trim()
    const targetPath = String(input.targetPath ?? '').trim()
    const kind = String(input.kind ?? '')
    if (!['depends_on', 'related_to'].includes(kind)) fail('INVALID_RELATION', 'kind must be depends_on or related_to')
    if (!sourcePath || !targetPath) fail('INVALID_RELATION', 'sourcePath and targetPath are required')
    if (sourcePath === targetPath) fail('INVALID_RELATION', 'self-links are not allowed')
    const source = sourcePath === '/' ? snapshot.repository : snapshot.modules.find(module => module.slug === sourcePath)
    const target = targetPath === '/' ? snapshot.repository : snapshot.modules.find(module => module.slug === targetPath)
    if (!source || !target) fail('NOT_FOUND', 'source or target module does not exist')
    source[kind] = (source[kind] ?? []).filter(item => item.target !== targetPath)
    if (!remove) source[kind].push({ target: targetPath, reason: String(input.reason ?? '').trim(), origin: 'manual' })
    await replaceFile(file, snapshot)
    return snapshot
  }

  async function context(projectPath, contextOptions = {}) {
    const { snapshot } = await readProject(projectPath)
    if (!snapshot) return null
    const queryText = String(contextOptions.query ?? '').trim()
    const result = queryText ? await query(projectPath, { query: queryText, limit: contextOptions.limit ?? 3 }) : null
    const selected = result?.matches?.length ? result.matches : snapshot.modules.slice(0, contextOptions.limit ?? 3).map(module => ({
      modulePath: module.slug, title: module.title, summary: module.summary, cardType: 'overview',
      snippet: module.cards.overview, sources: module.cardSources.overview,
    }))
    const lines = ['# Repository ontology', '', `Project: ${snapshot.title}`, `Root: ${snapshot.projectPath}`,
      `Files: ${snapshot.stats.files}; modules: ${snapshot.stats.modules}; baseline: ${snapshot.baseline.head ?? snapshot.baseline.fingerprint.slice(0, 12)}`, '']
    for (const match of selected) {
      lines.push(`## ${match.title} (${match.modulePath})`, '', match.snippet || match.summary, '')
      for (const source of (match.sources ?? []).slice(0, 4)) lines.push(`- source: ${source.path}:${source.lineStart}-${source.lineEnd}`)
      lines.push('')
    }
    const maxChars = Math.max(500, Math.min(20_000, Number(contextOptions.chars) || 5000))
    return lines.join('\n').slice(0, maxChars)
  }

  return {
    generate,
    status,
    list,
    read,
    query,
    link: (projectPath, input = {}) => mutateRelation(projectPath, input, false),
    unlink: (projectPath, input = {}) => mutateRelation(projectPath, input, true),
    context,
    dispose: async () => {},
  }
}
