import { ExecutorContext } from '@nx/devkit';
import childProcess from 'child_process';
import * as enquirer from 'enquirer';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { readFileSync, writeFileSync } from 'fs-extra';
import { resolve as nodeResolve } from 'path';
import { build, parse } from 'plist';
import { AndroidSchema } from '../schemas/android-properties.schema';
import { Platform } from '../schemas/base.schema';
import { mergeDeep } from '../schemas/deep-merge';
import { IosSchema } from '../schemas/ios-properties.schema';
import { COMMANDS } from './commands';
import { ExecutorSchema } from './types';

export function commonExecutor(options: ExecutorSchema, context: ExecutorContext): Promise<{ success: boolean }> {
  // global vars
  const isWindows = process.platform === 'win32';
  let projectCwd: string;

  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve, reject): Promise<{ success: boolean }> => {
    try {
      const isBuild = options.command === COMMANDS.BUILD;
      const isClean = options.command === COMMANDS.CLEAN;
      const isDebug = options.command === COMMANDS.DEBUG;
      const isPrepare = options.command === COMMANDS.PREPARE;
      const isRun = options.command === COMMANDS.RUN;
      const isTest = options.command === COMMANDS.TEST;
      const isSilent = options.silent === true;

      const platformCheck = [context.configurationName, options.platform].concat(options?.['_']);
      let isIos = platformCheck.some((overrides) => overrides === 'ios');
      let isAndroid = platformCheck.some((overrides) => overrides === 'android');

      if (!isAndroid && !isIos) {
        const platform = await selectPlatform(options);
        isIos = platform === 'ios';
        isAndroid = platform === 'android';
      }

      options.platform = isAndroid ? 'android' : 'ios';

      const projectConfig = context.projectsConfigurations.projects[context.projectName];
      projectCwd = projectConfig.root;

      const target = projectConfig.targets[options.command];
      const targetOptions = target.options;
      const targetPlatformOptions = targetOptions[options.platform];
      // const targetDescription = JSON.parse(process.argv.find((arg) => arg.indexOf('targetDescription') !== -1));

      // fix for nx overwriting android and ios sub properties
      mergeDeep(options, targetOptions);

      const configurationName = await selectConfiguration(target.configurations, context.configurationName);
      // fix for nx overwriting android and ios sub properties
      if (configurationName) mergeDeep(options, target.configurations[configurationName]);

      const nsOptions = prepareNsOptions(options, projectCwd);
      const additionalArgs: string[] = []; // Assuming any extra flags are handled here

      if (options.android?.xmlUpdates) updateXml(options.android.xmlUpdates, 'android');
      if (options.ios?.plistUpdates) updateXml(options.ios.plistUpdates, 'android');

      await checkOptions();

      return runCommand(nsOptions, additionalArgs);
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });

  async function selectPlatform(options: ExecutorSchema): Promise<Platform> {
    if (options.silent) {
      if (!options.platform) {
        console.warn('No platform was specified. Defaulting to iOS.');
        return 'ios';
      }
      return options.platform;
    }

    if (!options.platform) {
      const platformChoices: Platform[] = ['ios', 'android'];
      const { platform } = await enquirer.prompt<{ platform: Platform }>({
        type: 'select',
        name: 'platform',
        message: 'Which platform do you want to target?',
        choices: platformChoices
      });
      return platform;
    }
    return options.platform;
  }

  async function selectConfiguration(targetConfigurations: any, configurationName: string) {
    if (!configurationName && targetConfigurations && Object.keys(targetConfigurations).length) {
      const { configurationName: selectedConfig } = await enquirer.prompt<{ configurationName: string }>({
        type: 'select',
        name: 'configurationName',
        message: 'No configuration was provided. Did you mean to select one of these configurations?',
        choices: ['No', ...Object.keys(targetConfigurations)]
      });
      if (selectedConfig == 'No') {
        console.warn(`Continuing with no configuration. Specify with --configuration=prod, -c=prod, or :prod`);
      }
      return selectedConfig !== 'No' ? selectedConfig : undefined;
    }
    return configurationName;
  }

  function prepareNsOptions(options: ExecutorSchema, projectCwd: string) {
    const nsOptions: string[] = [];
    nsOptions.push(options.command);

    // early exit for `ns clean`
    if (options.command === COMMANDS.CLEAN) {
      return nsOptions;
    }

    const platformOptions = options[options.platform];
    if (platformOptions) {
      if (options.platform === 'android') {
        const androidPlatformOptions = platformOptions as AndroidSchema;
        androidPlatformOptions.aab && nsOptions.push('--aab');
        androidPlatformOptions.keyStorePath && nsOptions.push(`--key-store-path=${androidPlatformOptions.keyStorePath}`);
        androidPlatformOptions.keyStorePassword && nsOptions.push(`--key-store-password=${androidPlatformOptions.keyStorePassword}`);
        androidPlatformOptions.keyStoreAlias && nsOptions.push(`--key-store-alias=${androidPlatformOptions.keyStoreAlias}`);
        androidPlatformOptions.keyStoreAliasPassword && nsOptions.push(`--key-store-alias-password=${androidPlatformOptions.keyStoreAliasPassword}`);
      }
      if (options.platform === 'ios') {
        const iosPlatformOptions = platformOptions as IosSchema;
        iosPlatformOptions.provision && nsOptions.push(`--provision=${iosPlatformOptions.provision}`);
      }
    }

    // Append common options
    options.platform && nsOptions.push(options.platform);
    options.clean && nsOptions.push('--clean');
    options.coverage && nsOptions.push('--env.codeCoverage');
    options.device && !options.emulator && nsOptions.push(`--device=${options.device}`);
    options.emulator && nsOptions.push('--emulator');
    options.noHmr && nsOptions.push('--no-hmr');
    options.timeout && options.timeout > -1 && nsOptions.push(`--timeout=${options.timeout}`);
    options.uglify && nsOptions.push('--env.uglify');
    options.verbose && nsOptions.push('--env.verbose');
    options.production && nsOptions.push('--env.production');
    options.forDevice && nsOptions.push('--for-device');
    options.release && nsOptions.push('--release');
    options.copyTo && nsOptions.push(`--copy-to=${options.copyTo}`);
    options.force !== false && nsOptions.push('--force');

    const nsFileReplacements: Array<string> = [];
    for (const fr of options.fileReplacements) {
      nsFileReplacements.push(`${fr.replace.replace(projectCwd, './')}:${fr.with.replace(projectCwd, './')}`);
    }
    nsFileReplacements.length && nsOptions.push(`--env.replace="${nsFileReplacements.join(',')}"`);

    return nsOptions;
  }

  function updateXml(xmlUpdatesConfig: Record<string, any>, type: Platform) {
    const xmlUpdatesKeys = Object.keys(xmlUpdatesConfig || {});
    for (const filePathKeys of xmlUpdatesKeys) {
      let xmlFilePath: string;
      if (filePathKeys.indexOf('.') === 0) {
        // resolve relative to project directory
        xmlFilePath = nodeResolve(projectCwd, filePathKeys);
      } else {
        // default to locating in App_Resources
        let defaultDir: string[];
        if (type === 'ios') {
          defaultDir = ['App_Resources', 'iOS'];
        } else if (type === 'android') {
          defaultDir = ['App_Resources', 'Android'];
        }
        xmlFilePath = nodeResolve(projectCwd, ...defaultDir, filePathKeys);
      }

      let xmlFileContent: any;
      const fileContent = readFileSync(xmlFilePath, 'utf8');
      const xmlUpdates = xmlUpdatesConfig[filePathKeys];

      if (type === 'ios') {
        xmlFileContent = parse(fileContent);
      } else if (type === 'android') {
        const parser = new XMLParser({
          ignoreAttributes: false,
          ignoreDeclaration: false,
          ignorePiTags: false,
          attributeNamePrefix: '',
          allowBooleanAttributes: true
        });
        xmlFileContent = parser.parse(fileContent);
      }

      let needsUpdate = false;
      const recursiveUpdate = function(target: any, updates: any): void {
        for (const key in updates) {
          if (typeof updates[key] === 'object' && !Array.isArray(updates[key])) {
            if (!target[key]) {
              target[key] = {};
            }
            recursiveUpdate(target[key], updates[key]);
          } else {
            if (Array.isArray(target[key])) {
              recursiveUpdate(target[key], updates[key]);
            } else {
              target[key] = updates[key];
              needsUpdate = true;
            }
          }
        }
      };
      recursiveUpdate(xmlFileContent, xmlUpdates);

      if (needsUpdate) {
        let newXmlFileContent;
        if (type === 'ios') {
          newXmlFileContent = build(xmlFileContent, { pretty: true, indent: '\t' });
        } else {
          const builder = new XMLBuilder({
            ignoreAttributes: false,
            format: true,
            suppressEmptyNode: true,
            attributeNamePrefix: '',
            suppressBooleanAttributes: false
          });
          newXmlFileContent = builder.build(xmlFileContent);
        }
        writeFileSync(xmlFilePath, newXmlFileContent);
        console.log(`Updated: ${xmlFilePath}`);
      }
    }
  }

  function checkOptions() {
    return async () => {
      if (!options.id) return;
      const id = await checkAppId();
      if (options.id !== id) {
        return new Promise<void>((resolve) => {
          const child = childProcess.spawn(isWindows ? 'ns.cmd' : 'ns', ['config', 'set', `${options.platform}.id`, options.id], {
            cwd: projectCwd,
            stdio: 'inherit',
            shell: isWindows ? true : undefined
          });
          child.on('close', (code) => {
            child.kill('SIGKILL');
            resolve();
          });
        });
      }
    };
  }

  function checkAppId(): Promise<string> {
    return new Promise((resolve) => {
      const child = childProcess.spawn(isWindows ? 'ns.cmd' : 'ns', ['config', 'get', `id`], {
        cwd: projectCwd,
        shell: isWindows ? true : undefined
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', function(data) {
        // ensure no newline chars at the end
        const appId: string = (data || '').toString().replace('\n', '').replace('\r', '');
        // console.log('existing app id:', appId);
        resolve(appId);
      });
      child.on('close', (code) => {
        child.kill('SIGKILL');
      });
    });
  }

  function runCommand(nsOptions: any, additionalArgs: string[]): Promise<{ success: boolean }> {
    let icon = '';
    if (!nsOptions.clean) {
      if (nsOptions.platform === 'ios') {
        icon = '';
      } else if (nsOptions.platform === 'android') {
        icon = '🤖';
      } else if (['vision', 'visionos'].includes(nsOptions.platform)) {
        icon = '🥽';
      }
    }

    console.log(`―――――――――――――――――――――――― ${icon}`);
    console.log(`Running NativeScript ${options.command === COMMANDS.TEST ? 'unit tests' : 'CLI'} in ${projectCwd}`);
    console.log(' ');
    console.log([`ns`, ...nsOptions, ...additionalArgs].join(' '));
    console.log(' ');

    if (additionalArgs.length) {
      console.log('Note: When using extra cli flags, ensure all key/value pairs are separated with =, for example: --provision="Name"');
      console.log(' ');
    }
    console.log(`---`);

    const child = childProcess.spawn(isWindows ? 'ns.cmd' : 'ns', [...nsOptions, ...additionalArgs], {
      cwd: projectCwd,
      stdio: 'inherit',
      shell: isWindows ? true : undefined
    });

    return new Promise((resolve) => {
      child.on('close', (code) => {
        resolve({ success: code === 0 });
      });
    });
  }
}
