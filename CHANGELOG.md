# Changelog

All notable changes to the CodeBridge MCP extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-08-27 (Stable Release)

### 🎉 First Stable Release

This marks the stable 1.0.0 release of CodeBridge MCP with mature multi-instance coordination and comprehensive VSCode integration.

#### ✅ Production Ready Features
- **Stable Multi-Instance Coordination**: Thoroughly tested master-worker architecture
- **Complete Tool Suite**: All 9 MCP tools fully functional and workspace-aware
- **Robust Failover System**: Automatic leader election with <30-second recovery
- **Enterprise-Grade Reliability**: Comprehensive error handling and monitoring

#### 🔧 Stability Improvements
- Enhanced coordination system reliability
- Improved port conflict resolution
- Optimized workspace detection and routing
- Better error recovery and logging

## [0.2.0] - 2025-08-27 (Initial Release)

### 🚀 Initial Release Features

#### Core Functionality
- **HTTP MCP Server**: Standards-compliant MCP server with HTTP transport
- **Embedded Architecture**: Single-process design with no external dependencies
- **Auto Port Discovery**: Automatic available port detection on ports 9100-9199
- **CORS Support**: Web-based MCP client compatibility
- **Custom Logo**: Professional SVG logo showing multi-instance coordination

#### 🎯 Multi-Instance Coordination System
- **Master-Worker Architecture**: Automatic detection and role assignment for multiple VSCode instances
- **Leader Election**: Raft-inspired consensus algorithm with deterministic tiebreaking
- **Intelligent Tool Routing**: Workspace-aware routing with fallback mechanisms
- **Automatic Failover**: Graceful shutdown coordination with <30-second recovery times
- **Split-Brain Prevention**: Deterministic conflict resolution system

#### 🛠️ Available MCP Tools
- `get_workspaces`: LLM-driven workspace discovery and targeting
- `get_diagnostics`: LSP diagnostics with workspace targeting (errors, warnings, hints)
- `get_open_files`: Currently open files with metadata across all instances
- `get_file_content`: File content with workspace-specific routing
- `get_selection`: Selected text and context with workspace targeting
- `find_references`: Cross-workspace symbol references
- `find_definition`: Symbol definitions with workspace routing
- `get_workspace_symbols`: Symbol search across all workspaces  
- `search_files`: File search with workspace filtering

#### 🎛️ Commands
- `CodeBridge MCP: Start Server`: Manual server startup
- `CodeBridge MCP: Stop Server`: Stop MCP server
- `CodeBridge MCP: Show Server Status`: Display server information
- `CodeBridge MCP: Toggle Debug Logging`: Debug mode toggle
- `CodeBridge MCP: Show Coordination Status`: Display master/worker status and connections
- `CodeBridge MCP: List Connected Instances`: Show all connected VSCode instances
- `CodeBridge MCP: Force Master Mode`: Override coordination detection (advanced)
- `CodeBridge MCP: Reset Coordination`: Restart coordination system

#### ⚙️ Configuration
- `codebridge-mcp.server.autoStart`: Auto-start on activation (default: true)
- `codebridge-mcp.server.port`: Preferred server port (default: 9100)
- `codebridge-mcp.debug.enableLogging`: Debug logging (default: false)
- `codebridge-mcp.coordination.*`: Full coordination system configuration
- `codebridge-mcp.failover.*`: Failover and reliability settings

#### 🏗️ Enhanced Features
- **Multi-Folder Workspace Support**: Full `.code-workspace` file support with folder enumeration
- **Smart Port Management**: Uses 9100-9199 range to avoid dev server conflicts
- **Workspace-Aware Tool Routing**: Tools automatically route to appropriate instances
- **Enhanced Health Monitoring**: Comprehensive instance health tracking and reporting
- **Full-Stack Development Support**: Perfect for frontend + backend + mobile development workflows

#### 🔧 Technical Improvements
- **Tool Call Integration**: Coordinator-aware tool registration and execution
- **Enhanced Error Handling**: Comprehensive error recovery and logging
- **Type Safety**: Full TypeScript coverage for coordination system
- **Performance Optimization**: Efficient tool routing and state management

---

## Development Phases

### ✅ Phase 1: Core Architecture
- Multi-instance detection and coordination framework
- Basic master-worker role assignment
- Coordination configuration system

### ✅ Phase 2: Tool Routing System  
- Workspace-specific, active-context, and aggregated tool strategies
- Remote tool execution framework
- Tool call logging and monitoring

### ✅ Phase 3: Master Coordination
- Master coordinator implementation
- Worker registration and management
- Heartbeat and health monitoring system

### ✅ Phase 4: Worker Coordination & Failover
- Worker coordinator with master registration
- Leader election algorithm implementation
- Automatic failover and recovery system

### ✅ Phase 5: Integration & Testing
- VSCode command integration  
- End-to-end coordination testing
- Port conflict resolution and workspace detection fixes

### 🚧 Phase 6: Advanced Features (In Progress)
- Performance optimizations
- Enhanced workspace management
- Additional coordination features

### 📋 Future Phases
- Advanced monitoring and analytics
- Plugin system for custom tools
- Enhanced security and authentication

---

## Technical Architecture

### Multi-Instance Coordination
The extension implements a sophisticated multi-instance coordination system:

1. **Automatic Detection**: First instance becomes master, subsequent instances detect and join as workers
2. **Leader Election**: Consensus-based election with health monitoring and automatic failover
3. **Tool Routing**: Intelligent routing based on workspace context and tool requirements
4. **Fault Tolerance**: Graceful handling of instance failures with automatic recovery

### Port Management
- **Master Port**: 9100 (configurable)
- **Worker Range**: 9101-9199 (configurable) 
- **Coordination Endpoints**: `/coordination/*` namespace
- **MCP Endpoints**: `/mcp`, `/health` on main server

### Workspace Support
- **Single-folder**: Traditional VSCode workspace
- **Multi-folder**: `.code-workspace` files with full folder enumeration
- **Cross-instance**: Tools can target specific workspaces or aggregate across all instances

---

## Migration Guide

### From 0.1.x to 0.2.x

#### Configuration Changes
- Default port changed from `3000` to `9100`
- Added coordination configuration section
- Enhanced workspace detection for multi-folder workspaces

#### New Features
- Multi-instance support (automatic)  
- Enhanced `get_workspaces` tool
- New coordination commands in Command Palette

#### Breaking Changes
- Port configuration may need updating if you've customized it
- Tool responses may include additional workspace context information
