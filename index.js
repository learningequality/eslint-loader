"use strict"

var assign = require("object-assign")
var loaderUtils = require("loader-utils")
var objectHash = require("object-hash")
var pkg = require("./package.json")
var path = require("path")
var createCache = require("loader-fs-cache")
var cache = createCache("eslint-loader")

var engines = {}

/**
 * Class representing an ESLintError.
 * @extends Error
 */
class ESLintError extends Error {
  /**
   * Create an ESLintError.
   * @param {string} messages - Formatted eslint errors.
   */
  constructor(messages) {
    super()
    this.name = "ESLintError"
    this.message = messages
    this.stack = ""
  }

  /**
   * Returns a stringified representation of our error. This method is called
   * when an error is consumed by console methods
   * ex: console.error(new ESLintError(formattedMessage))
   * @return {string} error - A stringified representation of the error.
   */
  inspect() {
    return this.message
  }
}

/**
 * Function to check if child file path is the same as a parent, or in a
 * subdirectory of the parent.
 * @param  {String}  child  Child file path
 * @param  {String}  parent Parent folder path
 * @return {Boolean}        Whether the child is or is in the parent folder
 */
function isInDir(child, parent) {
  if (child === parent) {
    return true
  }
  var parentTokens = parent.split(path.sep).filter(i => i.length)
  return parentTokens.every((t, i) => child.split(path.sep)[i] === t)
}

/**
 * printLinterOutput
 *
 * @param {Object} eslint.executeOnText return value
 * @param {Object} config eslint configuration
 * @param {Object} webpack webpack instance
 * @return {void}
 */
function printLinterOutput(res, config, webpack) {
  // skip ignored file warning
  if (
    !(res.warningCount === 1 &&
      res.results[0].messages[0] &&
      res.results[0].messages[0].message &&
      res.results[0].messages[0].message.indexOf("ignore") > 1)
  ) {
    // quiet filter done now
    // eslint allow rules to be specified in the input between comments
    // so we can found warnings defined in the input itself
    if (res.warningCount && config.quiet) {
      res.warningCount = 0
      res.results[0].warningCount = 0
      res.results[0].messages = res.results[0].messages.filter(function(
        message
      ) {
        return message.severity !== 1
      })
    }

    // if enabled, use eslint auto-fixing where possible
    if (config.fix && res.results[0].output) {
      var eslint = require(config.eslintPath)
      eslint.CLIEngine.outputFixes(res)
    }

    if (res.errorCount || res.warningCount) {
      // add filename for each results so formatter can have relevant filename
      res.results.forEach(function(r) {
        r.filePath = webpack.resourcePath
      })
      var messages = config.formatter(res.results)

      if (config.outputReport && config.outputReport.filePath) {
        var reportOutput
        // if a different formatter is passed in as an option use that
        if (config.outputReport.formatter) {
          reportOutput = config.outputReport.formatter(res.results)
        }
        else {
          reportOutput = messages
        }
        var filePath = loaderUtils.interpolateName(webpack,
          config.outputReport.filePath, {
            content: res.results.map(function(r) {
              return r.source
            }).join("\n"),
          }
        )
        webpack.emitFile(filePath, reportOutput)
      }

      // default behavior: emit error only if we have errors
      var emitter = res.errorCount ? webpack.emitError : webpack.emitWarning

      // force emitError or emitWarning if user want this
      if (config.emitError) {
        emitter = webpack.emitError
      }
      else if (config.emitWarning) {
        emitter = webpack.emitWarning
      }

      if (emitter) {
        if (config.failOnError && res.errorCount) {
          throw new ESLintError(
            "Module failed because of a eslint error.\n" + messages
          )
        }
        else if (config.failOnWarning && res.warningCount) {
          throw new ESLintError(
            "Module failed because of a eslint warning.\n" + messages
          )
        }

        emitter(new ESLintError(messages))
      }
      else {
        throw new Error(
          "Your module system doesn't support emitWarning. " +
            "Update available? \n" +
            messages
        )
      }
    }
  }
}

/**
 * webpack loader
 *
 * @param  {String|Buffer} input JavaScript string
 * @param {Object} map input source map
 * @return {void}
 */
module.exports = function(input, map) {
  var webpack = this

  var userOptions = assign(
    // user defaults
    (webpack.options && webpack.options.eslint) || webpack.query || {},
    // loader query string
    loaderUtils.getOptions(webpack)
  )

  var userEslintPath = userOptions.eslintPath
  var formatter = require("eslint/lib/formatters/stylish")

  if (userEslintPath) {
    try {
      formatter = require(userEslintPath + "/lib/formatters/stylish")
    }
    catch (e) {
      formatter = require("eslint/lib/formatters/stylish")
    }
  }

  var config = assign(
    // loader defaults
    {
      formatter: formatter,
      cacheIdentifier: JSON.stringify({
        "eslint-loader": pkg.version,
        eslint: require(userEslintPath || "eslint").version,
      }),
      eslintPath: "eslint",
    },
    userOptions
  )

  var cacheDirectory = config.cache
  var cacheIdentifier = config.cacheIdentifier

  delete config.cacheIdentifier

  // Create the engine only once per config
  var configHash = objectHash(config)
  if (!engines[configHash]) {
    var eslint = require(config.eslintPath)
    engines[configHash] = new eslint.CLIEngine(config)
  }

  webpack.cacheable()

  var resourcePath = webpack.resourcePath
  var cwd = process.cwd()

  // remove cwd from resource path in case webpack has been started from project
  // root, to allow having relative paths in .eslintignore
  if (isInDir(resourcePath, cwd)) {
    resourcePath = resourcePath.substr(cwd.length + 1)
  }

  var engine = engines[configHash]
  // return early if cached
  if (config.cache) {
    var callback = webpack.async()
    return cache(
      {
        directory: cacheDirectory,
        identifier: cacheIdentifier,
        options: config,
        source: input,
        transform: function() {
          return lint(engine, input, resourcePath)
        },
      },
      function(err, res) {
        if (err) {
          return callback(err)
        }
        printLinterOutput(res || {}, config, webpack)
        return callback(null, input, map)
      }
    )
  }
  printLinterOutput(lint(engine, input, resourcePath), config, webpack)
  webpack.callback(null, input, map)
}

function lint(engine, input, resourcePath) {
  return engine.executeOnText(input, resourcePath, true)
}
