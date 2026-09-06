import { Command, CommanderError } from "commander";

import { createDemoCommand } from "./commands/demo.js";
import { createRecoverCommand } from "./commands/recover.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { createInitCommand } from "./commands/init.js";
import { createLoginCommand } from "./commands/login.js";
import { createLogoutCommand } from "./commands/logout.js";
import { createSchemaCommand } from "./commands/schema.js";
import { createTestCommand } from "./commands/test.js";
import { createWhoamiCommand } from "./commands/whoami.js";
import { AwError, exitCodeFor, sanitizeTerminal } from "./errors.js";
import { CLI_VERSION } from "./version.js";

export interface CliIo {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
}

interface CliState {
  requestedExitCode: number;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const states = new WeakMap<Command, CliState>();

export function createCli(io: CliIo = {}): Command {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const state: CliState = { requestedExitCode: 0, stderr };
  const requestExitCode = (code: number): void => {
    state.requestedExitCode = Math.max(state.requestedExitCode, code);
  };
  const stdoutLine = (message: string): void => {
    stdout.write(`${message}\n`);
  };
  const stderrLine = (message: string): void => {
    stderr.write(`${message}\n`);
  };

  const program = new Command()
    .name("augmentworks")
    .description("Deterministic hosted and customer-executed local AI agent testing")
    .version(CLI_VERSION, "-V, --version", "print the CLI version")
    .showSuggestionAfterError(true)
    .showHelpAfterError()
    .configureOutput({
      writeOut: (value) => stdout.write(value),
      writeErr: (value) => stderr.write(value),
      outputError: (value, write) => write(sanitizeTerminal(value))
    });

  program.addCommand(createLoginCommand({ stdout: stdoutLine, stderr: stderrLine }));
  program.addCommand(createLogoutCommand({ stdout: stdoutLine, stderr: stderrLine }));
  program.addCommand(createWhoamiCommand({ stdout: stdoutLine, stderr: stderrLine }));
  program.addCommand(createInitCommand({ stdout }));
  program.addCommand(createDoctorCommand({ stdout, setExitCode: requestExitCode }));
  program.addCommand(createDemoCommand({ stdout, stderr, setExitCode: requestExitCode }));
  program.addCommand(createTestCommand({ stdout, stderr, setExitCode: requestExitCode }));
  program.addCommand(createRecoverCommand({ stdout, stderr, setExitCode: requestExitCode }));
  program.addCommand(createSchemaCommand({ stdout }));

  states.set(program, state);
  return program;
}

export async function runCli(argv: readonly string[] = process.argv, io: CliIo = {}): Promise<number> {
  const program = createCli(io);
  const state = states.get(program);
  if (state === undefined) throw new Error("CLI state was not initialized");
  program.exitOverride();
  if (argv.length <= 2) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync([...argv], { from: "node" });
    return state.requestedExitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof AwError) {
      const code = sanitizeTerminal(error.code).replace(/[\r\n]+/g, " ");
      const message = sanitizeTerminal(error.message).replace(/[\r\n]+/g, " ").trim();
      state.stderr.write(`Error [${code}]: ${message || "The command could not be completed."}\n`);
      return exitCodeFor(error);
    }
    state.stderr.write("Error [INTERNAL]: An unexpected internal error occurred. Please report this issue.\n");
    return 1;
  }
}
