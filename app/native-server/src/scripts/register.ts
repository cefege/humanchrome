#!/usr/bin/env node
import path from 'path';
import { COMMAND_NAME } from './constant';
import { colorText, registerWithElevatedPermissions, writeNodePathFile } from './utils';

async function main(): Promise<void> {
  console.log(colorText(`Registering ${COMMAND_NAME} Native Messaging host...`, 'blue'));

  try {
    // Write Node.js path before registration
    writeNodePathFile(path.join(__dirname, '..'));

    await registerWithElevatedPermissions();
    console.log(
      colorText(
        'Registration succeeded. The Chrome extension can now talk to the native host.',
        'green',
      ),
    );
  } catch (error: any) {
    console.error(colorText(`Registration failed: ${error.message}`, 'red'));
    process.exit(1);
  }
}

main();
