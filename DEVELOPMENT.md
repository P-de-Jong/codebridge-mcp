# Development Guide

## Setting Up Development Environment

### 1. Install Dependencies

```bash
bun install
```

### 2. Build All Packages

```bash
bun run build
```

## Testing the MCP Server

### Manual Testing with JSON-RPC

Start the MCP server:

```bash
bun run mcp:dev
```

Test the MCP tools with a simple echo test:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | bun packages/mcp-server/dist/index.js
```

Expected response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      { "name": "get_diagnostics", "description": "Get LSP diagnostics..." },
      {
        "name": "get_open_files",
        "description": "Get list of currently open files..."
      }
      // ... more tools
    ]
  }
}
```

### Testing with VSCode Extension

1. **Development Mode:**

   ```bash
   cd packages/vscode-mcp
   code .
   # Press F5 to launch Extension Development Host
   ```

2. **Check Connection Status:**
   - Look for "$(plug) MCP Connected" in the status bar
   - Run command "CodeBridge MCP: Show Connection Status"

3. **Test WebSocket Connection:**

   ```bash
   # In another terminal, start the MCP server
   bun run mcp:dev

   # You should see connection logs when VSCode connects
   ```

## Package Development

### MCP Server (`packages/mcp-server`)

**Watch mode during development:**

```bash
bun run mcp:dev
```

**Key files:**

- `src/index.ts` - Entry point and server startup
- `src/mcp-handler.ts` - MCP protocol implementation
- `src/websocket-server.ts` - WebSocket server for VSCode
- `src/connection-manager.ts` - Manages VSCode connections
- `src/tools/` - Individual MCP tool implementations

**Adding a new MCP tool:**

1. Create tool file: `src/tools/my-tool.ts`

```typescript
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ConnectionManager } from '../connection-manager.js';

export function createMyTool(_connectionManager: ConnectionManager): Tool {
  return {
    name: 'my_tool',
    description: 'Description of what my tool does',
    inputSchema: {
      type: 'object',
      properties: {
        param1: { type: 'string', description: 'First parameter' },
      },
      required: ['param1'],
      additionalProperties: false,
    },
  };
}

export async function handleMyTool(
  connectionManager: ConnectionManager,
  args: { param1: string; workspaceId?: string }
): Promise<any> {
  // Implementation
  return { result: 'success' };
}
```

2. Register in `src/mcp-handler.ts`:

```typescript
import { createMyTool, handleMyTool } from './tools/my-tool.js';

// Add to tools list in setupHandlers()
createMyTool(this.connectionManager),

// Add to switch statement in CallToolRequestSchema handler
case 'my_tool':
  return await handleMyTool(this.connectionManager, args || {});
```

### VSCode Extension (`packages/vscode-extension`)

**Watch mode during development:**

```bash
cd packages/vscode-mcp
bun run dev
```

**Key files:**

- `src/extension.ts` - Extension entry point and activation
- `src/websocket-client.ts` - WebSocket client for MCP server
- `src/handlers/` - Request handlers for each MCP tool

**Adding a new handler:**

1. Create handler: `src/handlers/my-handler.ts`

```typescript
import * as vscode from 'vscode';
import { WSMessage } from '../websocket-client';

export function createMyHandler() {
  return async (message: WSMessage): Promise<any> => {
    const { param1 } = message.params || {};

    // Use VSCode API to get information
    const result = await vscode.commands.executeCommand(
      'some.vscode.command',
      param1
    );

    return { result };
  };
}
```

2. Register in `src/extension.ts`:

```typescript
import { createMyHandler } from './handlers/my-handler';

// In activate() function
client.registerHandler('my_tool', createMyHandler());
```

### Shared Package (`packages/shared`)

**Key files:**

- `src/types.ts` - Type definitions used by both server and extension
- `src/messages.ts` - WebSocket message protocol definitions
- `src/constants.ts` - Shared constants and configuration

**Adding new types:**

```typescript
// In types.ts
export interface MyNewType {
  field1: string;
  field2: number;
}

// In messages.ts
export interface MyToolRequest extends WSMessage {
  type: 'request';
  method: 'my_tool';
  params: {
    param1: string;
  };
}
```

## Debugging

### MCP Server Debugging

1. **Enable verbose logging:**

```typescript
console.log('Debug message:', data);
console.error('Error details:', error);
```

2. **Test WebSocket directly:**

```bash
# Install wscat for testing
npm install -g wscat

# Connect to server
wscat -c ws://localhost:3000

# Send test message
{"id":"test","type":"notification","method":"handshake","params":{"workspaceId":"test","workspaceName":"test","workspacePath":"/tmp","vscodeVersion":"1.80.0","extensionVersion":"0.1.0"},"timestamp":1234567890}
```

### VSCode Extension Debugging

1. **Use Developer Console:**
   - `Ctrl/Cmd + Shift + P` → "Developer: Toggle Developer Tools"
   - Check Console tab for extension logs

2. **Extension logs:**

```typescript
console.log('Extension debug:', data);
// Logs appear in VSCode's Output panel under "CodeBridge MCP"
```

3. **Breakpoints:**
   - Set breakpoints in TypeScript source files
   - Use F5 to start debugging session

### Connection Issues

**Common issues:**

1. **WebSocket constructor error:**

   ```
   TypeError: WebSocket is not a constructor
   ```

   **Fix:** Ensure `ws` package is installed and imported correctly:

   ```bash
   cd packages/vscode-mcp
   bun add ws@^8.18.0 uuid@^9.0.0
   bun add -D @types/ws@^8.5.0 @types/uuid@^9.0.0
   ```

2. **Port already in use:**

   ```bash
   # Find process using port 3000
   lsof -i :3000

   # Kill process if needed
   kill -9 <PID>
   ```

3. **Extension not connecting:**
   - Check MCP server is running: `bun run mcp:dev`
   - Verify port configuration matches
   - Check firewall settings
   - Look for WebSocket connection errors in console
   - Test connection manually: `wscat -c ws://localhost:3000`

4. **MCP tools not working:**
   - Ensure VSCode workspace is open
   - Check language servers are active
   - Verify file URIs are correct format

## Testing Scenarios

### Basic Functionality Test

1. Start MCP server: `bun run mcp:dev`
2. Open VSCode with extension
3. Check status bar shows "MCP Connected"
4. Open a TypeScript file with some errors
5. Test each tool:

```bash
# Test via MCP client (if you have one)
# Or check that extension properly handles requests from server
```

### Multi-Workspace Test

1. Start MCP server
2. Open multiple VSCode windows with different workspaces
3. Verify each workspace gets separate connection
4. Test that tools work correctly with workspace targeting

### Reconnection Test

1. Start MCP server and VSCode extension
2. Kill MCP server
3. Verify extension shows "Reconnecting..." status
4. Restart MCP server
5. Verify automatic reconnection works

## Performance Considerations

- **Large workspaces**: Symbol search may be slow
- **Many diagnostics**: Limit requests to specific files when possible
- **Connection pooling**: Server efficiently manages multiple VSCode instances
- **Message batching**: Consider batching for bulk operations

## Release Process

1. **Update version numbers** in all package.json files
2. **Build all packages:** `bun run build`
3. **Test thoroughly** with the scenarios above
4. **Package extension:** `cd packages/vscode-mcp && bun run package`
5. **Tag release:** `git tag v0.1.0 && git push --tags`
