# CodeBridge MCP

**Transform your VSCode into a powerful MCP server** - Give AI assistants seamless access to your entire development environment with intelligent multi-instance coordination.

## 🚀 Quick Setup

### 1. Install & Auto-Start
1. Install the CodeBridge MCP extension in VSCode
2. Extension automatically starts as MCP server on port `9100`
3. Your VSCode is now accessible via MCP! 🎉

### 2. Connect Your AI Assistant

#### Claude Code
```bash
claude mcp add --transport http codebridge http://localhost:9100/mcp
```

#### OpenCode Configuration
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codebridge-mcp": {
      "type": "local",
      "command": [
        "npx", "mcp-remote", "http://localhost:9100/mcp",
        "--allow-http", "--transport", "http-only"
      ],
      "enabled": true
    }
  }
}
```

#### Claude Desktop Configuration  
```json
{
  "mcpServers": {
    "codebridge-mcp": {
      "command": "npx",
      "args": [
        "mcp-remote", "http://localhost:9100/mcp",
        "--allow-http", "--transport", "http-only"
      ]
    }
  }
}
```

#### Any MCP Client
```
http://localhost:9100/mcp
```

## ✨ Why Choose CodeBridge MCP?

### 🏗️ Full-Stack Development Made Easy
- **Multi-Instance Support**: React frontend (VSCode #1) + Node.js backend (VSCode #2) + Mobile app (VSCode #3) - all accessible through one MCP connection
- **Intelligent Routing**: AI automatically knows which workspace to target for each request
- **Live Context**: Real-time diagnostics, open files, and editor state - not just static files
- **Zero Setup**: Works with your existing VSCode setup, no LSP configuration needed

### 🤖 AI-Powered Features
- **Real-Time Analysis**: AI sees live diagnostics and errors as you code
- **Cross-Project Intelligence**: AI understands relationships between frontend/backend code  
- **Context-Aware Suggestions**: Based on your actual workspace state and current selection
- **Rich Metadata**: Symbols, references, definitions - full IDE context for AI

### 🛠️ Available MCP Tools
- `get_workspaces` - Discover all VSCode instances and workspace folders
- `get_diagnostics` - Live LSP diagnostics with workspace targeting
- `get_open_files` - Open files across all instances (aggregated)
- `get_file_content` - File content with workspace-specific routing
- `get_selection` - Selected text and context with workspace targeting
- `find_references` - Cross-workspace symbol references
- `find_definition` - Symbol definitions with workspace routing  
- `get_workspace_symbols` - Symbol search across all workspaces
- `search_files` - File search with workspace filtering

## 📋 Requirements

- **VSCode 1.80.0+** - The extension runs inside VSCode
- **Node.js 18+** - For MCP client connections (if using npm-based clients)  
- **No external dependencies** - Everything is self-contained in the extension

> **Note**: The extension creates an HTTP MCP server that any MCP-compatible client can connect to.

## ⚙️ Extension Settings

### Server Configuration
- `codebridge-mcp.server.autoStart`: Auto-start MCP server on activation (default: true)
- `codebridge-mcp.server.port`: Preferred MCP server port (default: 9100)
- `codebridge-mcp.debug.enableLogging`: Debug logging for troubleshooting (default: false)

### Multi-Instance Coordination  
- `codebridge-mcp.coordination.enabled`: Enable multi-instance coordination (default: true)
- `codebridge-mcp.coordination.mode`: Force coordination mode - "auto", "master", "worker", "standalone" (default: "auto")
- `codebridge-mcp.coordination.masterPort`: Master instance port (default: 9100)
- `codebridge-mcp.coordination.workerPortRange`: Worker port range (default: [9101, 9199])

### Failover & Reliability
- `codebridge-mcp.failover.enabled`: Enable automatic failover (default: true)
- `codebridge-mcp.failover.electionTimeout`: Leader election timeout in ms (default: 5000)
- `codebridge-mcp.failover.healthCheckInterval`: Health check frequency in ms (default: 3000)

## 🎛️ Commands

### Server Management
- `CodeBridge MCP: Start Server` - Start the MCP server
- `CodeBridge MCP: Stop Server` - Stop the MCP server  
- `CodeBridge MCP: Show Server Status` - Display server and workspace info
- `CodeBridge MCP: Toggle Debug Logging` - Enable/disable debug logging

### Multi-Instance Coordination
- `CodeBridge MCP: Show Coordination Status` - Display master/worker status and connections
- `CodeBridge MCP: List Connected Instances` - Show all connected VSCode instances
- `CodeBridge MCP: Force Master Mode` - Override coordination detection (advanced)
- `CodeBridge MCP: Reset Coordination` - Restart coordination system

### 3. Start Using MCP Tools

```typescript
// Discover all your workspaces
await client.callTool("get_workspaces", {});

// Get real-time diagnostics from your code
await client.callTool("get_diagnostics", { 
  workspace: "MyProject" 
});

// Access your open files
await client.callTool("get_open_files", {});

// Get your current selection
await client.callTool("get_selection", {});
```

### 4. Multi-Instance Setup (Advanced)
Perfect for **full-stack development** - have separate VSCode instances for frontend, backend, mobile app, etc., all accessible through one MCP connection!

**Example workflow:**
```
VSCode #1: React Frontend (port 9100 - Master)
VSCode #2: Node.js Backend (port 9101 - Worker)  
VSCode #3: Mobile App (port 9102 - Worker)

→ AI Assistant connects once to port 9100
→ Gets unified access to all three codebases
→ Can analyze frontend/backend interactions
→ Routes tools to the right project automatically
```

## 🏗️ Architecture

### Master-Worker Coordination
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   VSCode #1     │    │   VSCode #2     │    │   VSCode #3     │
│   (Master)      │    │   (Worker)      │    │   (Worker)      │
│   Port: 9100    │◄──►│   Port: 9101    │    │   Port: 9102    │
│   ┌───────────┐ │    │   ┌───────────┐ │    │   ┌───────────┐ │
│   │MCP Server │ │    │   │Local Tools│ │    │   │Local Tools│ │
│   │+ Coord    │ │    │   │           │ │    │   │           │ │
│   └───────────┘ │    │   └───────────┘ │    │   └───────────┘ │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         ▲
         │
    ┌────────────┐
    │ MCP Client │ (Always connects to port 9100)
    └────────────┘
```

### Technical Stack
- **Express.js**: HTTP server and coordination endpoints
- **@modelcontextprotocol/sdk**: Standards-compliant MCP transport
- **VSCode API**: Direct access for optimal performance
- **TypeScript**: Full type safety and robust error handling
- **Leader Election**: Raft-inspired consensus for fault tolerance



## 🔧 Development

Build and package the extension:

```bash
# Install dependencies
bun install

# Build the extension
bun run build

# Package for distribution
bun run package

# Run in development mode
bun run dev
```

## 🐛 Troubleshooting

### Port Already in Use
If port 9100 is occupied, the extension will automatically find the next available port (9101, 9102, etc.). Check VSCode status bar or run `CodeBridge MCP: Show Server Status` to see the actual port.

### Connection Issues
1. Ensure VSCode extension is running (`CodeBridge MCP: Show Server Status`)
2. Verify the MCP endpoint URL matches your server port
3. Check firewall settings allow localhost connections
4. Enable debug logging: `CodeBridge MCP: Toggle Debug Logging`

### Multi-Instance Issues
- Only connect MCP clients to the master instance (usually port 9100)
- Use `CodeBridge MCP: Show Coordination Status` to check master/worker roles
- Reset coordination if needed: `CodeBridge MCP: Reset Coordination`

```bash
# Install dependencies
bun install

# Build the extension
bun run build

# Package for distribution
bun run package

# Run in development mode
bun run dev
```

## 🤝 Contributing

See [DEVELOPMENT.md](DEVELOPMENT.md) for technical details and contribution guidelines.

---
