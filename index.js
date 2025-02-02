const os = require('os')
const fs = require('fs')
const path = require('path')
const core = require('@actions/core')
const common = require('./common')
const bundler = require('./bundler')

const windows = common.windows

const inputDefaults = {
  'ruby-version': 'default',
  'bundler': 'default',
  'bundler-cache': 'true',
  'working-directory': '.',
  'cache-version': bundler.DEFAULT_CACHE_VERSION,
}

// entry point when this action is run on its own
export async function run() {
  try {
    await setupRuby()
  } catch (error) {
    core.setFailed(error.message)
  }
}

// entry point when this action is run from other actions
export async function setupRuby(options = {}) {
  console.log('Setting up Ruby');
  const inputs = { ...options }
  for (const key in inputDefaults) {
    if (!Object.prototype.hasOwnProperty.call(inputs, key)) {
      inputs[key] = core.getInput(key) || inputDefaults[key]
    }
  }

  process.chdir(inputs['working-directory'])

  const platform = common.getVirtualEnvironmentName()
  console.log('Parsing Ruby engine and version');
  const [engine, parsedVersion] = parseRubyEngineAndVersion(inputs['ruby-version'])

  console.log('Requiring installer');
  let installer
  if (platform.startsWith('windows-') && engine !== 'jruby') {
    installer = require('./windows')
  } else {
    installer = require('./ruby-builder')
  }

  console.log('Getting available ruby versions');
  const engineVersions = installer.getAvailableVersions(platform, engine)
  console.log('Validating Ruby engine and version');
  const version = validateRubyEngineAndVersion(platform, engineVersions, engine, parsedVersion)

  console.log('Creating .gemrc');
  createGemRC()
  console.log('Running envPreInstall');
  envPreInstall()

  console.log('Installing Ruby');
  const rubyPrefix = await installer.install(platform, engine, version)

  console.log('Running after setup hook');
  // When setup-ruby is used by other actions, this allows code in them to run
  // before 'bundle install'.  Installed dependencies may require additional
  // libraries & headers, build tools, etc.
  if (inputs['afterSetupPathHook'] instanceof Function) {
    await inputs['afterSetupPathHook']({ platform, rubyPrefix, engine, version })
  }

  if (inputs['bundler'] !== 'none') {
    console.log('Detecting Gemfiles');
    const [gemfile, lockFile] = bundler.detectGemfiles()

    console.log('Installing bundler');
    const bundlerVersion = await common.measure('Installing Bundler', async () =>
        bundler.installBundler(inputs['bundler'], lockFile, platform, rubyPrefix, engine, version))

    console.log('Running bundle install');
    if (inputs['bundler-cache'] === 'true') {
      await common.measure('bundle install', async () =>
          bundler.bundleInstall(gemfile, lockFile, platform, engine, version, bundlerVersion, inputs['cache-version']))
    }
  }

  core.setOutput('ruby-prefix', rubyPrefix)
}

function parseRubyEngineAndVersion(rubyVersion) {
  if (rubyVersion === 'default') {
    if (fs.existsSync('.ruby-version')) {
      rubyVersion = '.ruby-version'
    } else if (fs.existsSync('.tool-versions')) {
      rubyVersion = '.tool-versions'
    } else {
      throw new Error('input ruby-version needs to be specified if no .ruby-version or .tool-versions file exists')
    }
  }

  if (rubyVersion === '.ruby-version') { // Read from .ruby-version
    rubyVersion = fs.readFileSync('.ruby-version', 'utf8').trim()
    console.log(`Using ${rubyVersion} as input from file .ruby-version`)
  } else if (rubyVersion === '.tool-versions') { // Read from .tool-versions
    const toolVersions = fs.readFileSync('.tool-versions', 'utf8').trim()
    const rubyLine = toolVersions.split(/\r?\n/).filter(e => e.match(/^ruby\s/))[0]
    rubyVersion = rubyLine.match(/^ruby\s+(.+)$/)[1]
    console.log(`Using ${rubyVersion} as input from file .tool-versions`)
  }

  let engine, version
  if (rubyVersion.match(/^(\d+)/) || common.isHeadVersion(rubyVersion)) { // X.Y.Z => ruby-X.Y.Z
    engine = 'ruby'
    version = rubyVersion
  } else if (!rubyVersion.includes('-')) { // myruby -> myruby-stableVersion
    engine = rubyVersion
    version = '' // Let the logic in validateRubyEngineAndVersion() find the version
  } else { // engine-X.Y.Z
    [engine, version] = common.partition(rubyVersion, '-')
  }

  return [engine, version]
}

function validateRubyEngineAndVersion(platform, engineVersions, engine, parsedVersion) {
  if (!engineVersions) {
    throw new Error(`Unknown engine ${engine} on ${platform}`)
  }

  let version = parsedVersion
  if (!engineVersions.includes(parsedVersion)) {
    const latestToFirstVersion = engineVersions.slice().reverse()
    // Try to match stable versions first, so an empty version (engine-only) matches the latest stable version
    let found = latestToFirstVersion.find(v => common.isStableVersion(v) && v.startsWith(parsedVersion))
    if (!found) {
      // Exclude head versions, they must be exact matches
      found = latestToFirstVersion.find(v => !common.isHeadVersion(v) && v.startsWith(parsedVersion))
    }

    if (found) {
      version = found
    } else {
      throw new Error(`Unknown version ${parsedVersion} for ${engine} on ${platform}
        available versions for ${engine} on ${platform}: ${engineVersions.join(', ')}
        Make sure you use the latest version of the action with - uses: ruby/setup-ruby@v1
        File an issue at https://github.com/ruby/setup-ruby/issues if would like support for a new version`)
    }
  }

  return version
}

function createGemRC() {
  const gemrc = path.join(os.homedir(), '.gemrc')
  if (!fs.existsSync(gemrc)) {
    fs.writeFileSync(gemrc, `gem: --no-document${os.EOL}`)
  }
}

// sets up ENV variables
// currently only used on Windows runners
function envPreInstall() {
  const ENV = process.env
  if (windows) {
    // puts normal Ruby temp folder on SSD
    core.exportVariable('TMPDIR', ENV['RUNNER_TEMP'])
    // bash - sets home to match native windows, normally C:\Users\<user name>
    core.exportVariable('HOME', ENV['HOMEDRIVE'] + ENV['HOMEPATH'])
    // bash - needed to maintain Path from Windows
    core.exportVariable('MSYS2_PATH_TYPE', 'inherit')
  }
}

if (__filename.endsWith('index.js')) { run() }
