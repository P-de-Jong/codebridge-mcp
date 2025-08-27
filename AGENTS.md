# Agent Guidelines for vscode-mcp-bridge

## Build/Test Commands
- `npm run build` - Build extension using esbuild
- `npm run compile` - Compile TypeScript
- `npm run lint` - Run ESLint on src/
- `npm run test` - Run VSCode extension tests
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check formatting

## Code Style
- Use single quotes (Prettier config)
- Strict TypeScript with all compiler options enabled
- camelCase/PascalCase naming convention for imports
- Always use semicolons, curly braces, and strict equality
- Error handling: Extract error messages with `error instanceof Error ? error.message : String(error)`
- Use logger from `./logger` for error/debug logging
- Import order: external modules first, then relative imports

## Architecture
- VSCode extension with MCP server coordination
- Main entry: `src/extension.ts` 
- Tools organized in `src/tools/`
- Coordination logic in `src/coordination/`
- Use dependency injection pattern for server instances