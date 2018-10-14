#!/usr/bin/env node

import { parse, DocumentNode } from 'graphql'
import { importSchema } from 'graphql-import'
import * as fs from 'fs'
import * as path from 'path'
import * as chalk from 'chalk'
import * as mkdirp from 'mkdirp'
import * as prettier from 'prettier'
import * as os from 'os'
import { GraphQLGenDefinition, Language } from 'graphqlgen-json-schema'
import {
  extractGraphQLTypes,
  extractGraphQLEnums,
  extractGraphQLUnions,
} from './source-helper'
import {
  getAbsoluteFilePath,
  getImportPathRelativeToOutput,
} from './path-helpers'
import {
  IGenerator,
  GenerateArgs,
  CodeFileLike,
  ModelMap,
} from './generators/types'
import {
  generate as generateTS,
  format as formatTS,
} from './generators/ts-generator'
// import {
//   generate as generateReason,
//   format as formatReason,
// } from './generators/reason-generator'
import {
  generate as generateFlow,
  format as formatFlow,
} from './generators/flow-generator'

import { generate as scaffoldTS } from './generators/ts-scaffolder'
import { generate as scaffoldFlow } from './generators/flow-scaffolder'
// import { generate as scaffoldReason } from './generators/reason-scaffolder'

import { parseConfig } from './yaml';

export type GenerateCodeArgs = {
  schema: DocumentNode
  modelMap?: ModelMap
  prettify?: boolean
  prettifyOptions?: prettier.Options
  language?: Language
}

function getTypesGenerator(language: Language): IGenerator {
  switch (language) {
    case 'typescript':
      return { generate: generateTS, format: formatTS }
    case 'flow':
      return { generate: generateFlow, format: formatFlow }
  }

  //TODO: This should never be reached as we validate the yaml before
  throw new Error(`Invalid language: ${language}`)
}

function getResolversGenerator(language: Language): IGenerator {
  switch (language) {
    case 'typescript':
      return { generate: scaffoldTS, format: formatTS }
    case 'flow':
      return { generate: scaffoldFlow, format: formatFlow }
  }

  //TODO: This should never be reached as we validate the yaml before
  throw new Error(`Invalid language: ${language}`)
}

interface ModelsConfig {
  [typeName: string]: string
}

function buildModelMap(
  modelsConfig: ModelsConfig,
  outputDir: string,
): ModelMap {
  return Object.keys(modelsConfig).reduce((acc, typeName) => {
    const modelConfig = modelsConfig[typeName]
    const [modelPath, modelTypeName] = modelConfig.split(':')
    const absoluteFilePath = getAbsoluteFilePath(modelPath)
    const importPathRelativeToOutput = getImportPathRelativeToOutput(
      absoluteFilePath,
      outputDir,
    )
    return {
      ...acc,
      [typeName]: {
        absoluteFilePath,
        importPathRelativeToOutput,
        modelTypeName,
      },
    }
  }, {})
}

function generateTypes(
  generateArgs: GenerateArgs,
  generateCodeArgs: GenerateCodeArgs,
): string {
  const generatorFn: IGenerator = getTypesGenerator(generateCodeArgs.language!)
  const generatedTypes = generatorFn.generate(generateArgs)

  return generateCodeArgs.prettify
    ? generatorFn.format(
        generatedTypes as string,
        generateCodeArgs.prettifyOptions,
      )
    : (generatedTypes as string)
}

function generateResolvers(
  generateArgs: GenerateArgs,
  generateCodeArgs: GenerateCodeArgs,
): CodeFileLike[] {
  const generatorFn: IGenerator = getResolversGenerator(generateCodeArgs.language!)
  const generatedResolvers = generatorFn.generate(
    generateArgs,
  ) as CodeFileLike[]

  return generatedResolvers.map(r => {
    return {
      path: r.path,
      force: r.force,
      code: generateCodeArgs.prettify
        ? generatorFn.format(r.code, generateCodeArgs.prettifyOptions)
        : r.code,
    }
  })
}

export function generateCode(
  generateCodeArgs: GenerateCodeArgs,
): { generatedTypes: string; generatedResolvers: CodeFileLike[] } {
  const generateArgs: GenerateArgs = {
    types: extractGraphQLTypes(generateCodeArgs.schema!),
    enums: extractGraphQLEnums(generateCodeArgs.schema!),
    unions: extractGraphQLUnions(generateCodeArgs.schema!),
    contextPath: '../resolvers/types/Context', //TODO: use contextPath from graphqlgen.yml
    modelMap: generateCodeArgs.modelMap!,
  }
  const generatedTypes = generateTypes(generateArgs, generateCodeArgs)
  const generatedResolvers = generateResolvers(generateArgs, generateCodeArgs)
  // const generatedModels = generateModels(generateArgs, {schema, prettify, prettifyOptions, language})

  return { generatedTypes, generatedResolvers }
}

function writeTypes(types: string, config: GraphQLGenDefinition): void {
  // Create generation target folder, if it does not exist
  // TODO: Error handling around this
  mkdirp.sync(path.dirname(config.output.types))
  try {
    fs.writeFileSync(config.output.types, types, { encoding: 'utf-8' })
  } catch (e) {
    console.error(
      chalk.default.red(
        `Failed to write the file at ${config.output.types}, error: ${e}`,
      ),
    )
    process.exit(1)
  }
  console.log(
    chalk.default.green(
      `Types and scalars resolvers generated at ${config.output.types}`,
    ),
  )
}

function writeResolvers(
  resolvers: CodeFileLike[],
  config: GraphQLGenDefinition,
) {
  const outputResolversDir = config.output.resolvers!
  // Create generation target folder, if it does not exist
  // TODO: Error handling around this
  mkdirp.sync(path.dirname(outputResolversDir))

  let didWarn = false

  resolvers.forEach(f => {
    const writePath = path.join(outputResolversDir, f.path)
    if (
      fs.existsSync(writePath) ||
      (path.resolve(path.dirname(writePath)) !==
        path.resolve(outputResolversDir) &&
        fs.existsSync(path.dirname(writePath)))
    ) {
      didWarn = true
      console.log(
        chalk.default.yellow(`Warning: file (${writePath}) already exists.`),
      )
      return
    }

    mkdirp.sync(path.dirname(writePath))
    try {
      fs.writeFileSync(
        writePath,
        f.code.replace('[TEMPLATE-INTERFACES-PATH]', config.output.types),
        {
          encoding: 'utf-8',
        },
      )
    } catch (e) {
      console.error(
        chalk.default.red(
          `Failed to write the file at ${outputResolversDir}, error: ${e}`,
        ),
      )
      process.exit(1)
    }
    console.log(chalk.default.green(`Code generated at ${writePath}`))
  })
  if (didWarn) {
    console.log(
      chalk.default.yellow(
        `${
          os.EOL
        }Please us the force flag (-f, --force) to overwrite the files.`,
      ),
    )
  }
  process.exit(0)
}

function parseSchema(schemaPath: string): DocumentNode {
  if (!fs.existsSync(schemaPath)) {
    console.error(
      chalk.default.red(`The schema file ${schemaPath} does not exist`),
    )
    process.exit(1)
  }

  let schema = undefined
  try {
    schema = importSchema(schemaPath)
  } catch (e) {
    console.error(
      chalk.default.red(`Error occurred while reading schema: ${e}`),
    )
    process.exit(1)
  }

  let parsedSchema = undefined

  try {
    parsedSchema = parse(schema!)
  } catch (e) {
    console.error(chalk.default.red(`Failed to parse schema: ${e}`))
    process.exit(1)
  }

  return parsedSchema!
}

async function run() {
  //TODO: Define proper defaults
  // const defaults: DefaultOptions = {
  //   outputInterfaces: 'src/generated/resolvers.ts',
  //   outputScaffold: 'src/resolvers/',
  //   language: 'typescript',
  //   interfaces: '../generated/resolvers.ts',
  //   force: false,
  // }

  const config = parseConfig()
  const parsedSchema = parseSchema(config.input.schema)

  const options = (await prettier.resolveConfig(process.cwd())) || {} // TODO: Abstract this TS specific behavior better
  if (JSON.stringify(options) !== '{}') {
    console.log(chalk.default.blue(`Found a prettier configuration to use`))
  }

  //TODO: Should we provide a default in case `config.output.types` is not defined?
  const modelMap = buildModelMap(config.input.models, config.output.types)

  const { generatedTypes, generatedResolvers } = generateCode({
    schema: parsedSchema!,
    language: config.language,
    prettify: true,
    prettifyOptions: options,
    modelMap,
  })

  writeTypes(generatedTypes, config)
  writeResolvers(generatedResolvers, config)
  /* writeModels(generatedResolvers, config); */
}

// Only call run when running from CLI, not when included for tests
if (require.main === module) {
  run()
}