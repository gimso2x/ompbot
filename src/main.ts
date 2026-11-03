#!/usr/bin/env bun
import { runCli } from "./cli";

process.exit(await runCli(process.argv.slice(2)));
