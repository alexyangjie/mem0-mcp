#!/usr/bin/env node

/**
 * MCP server for interacting with Mem0.ai memory storage.
 * Provides tools to add and search memories.
 *
 * Supports two modes:
 * 1. Cloud mode: Uses Mem0's hosted API with MEM0_API_KEY
 * 2. Local mode: Uses in-memory storage with OPENAI_API_KEY for embeddings
 */

// Create a wrapper around console to safely redirect logs from libraries
// This ensures MCP protocol communication is not affected
class SafeLogger {
  private originalConsoleLog: typeof console.log;

  constructor() {
    // Store the original console.log
    this.originalConsoleLog = console.log;

    // Redirect console.log to stderr only for our module
    console.log = (...args) => {
      // Check if it's from the mem0ai library or our code
      const stack = new Error().stack || '';
      if (stack.includes('mem0ai') || stack.includes('mem0-mcp')) {
        console.error('[redirected log]', ...args);
      } else {
        // Keep normal behavior for MCP protocol and other code
        this.originalConsoleLog.apply(console, args);
      }
    };
  }

  // Restore original behavior
  restore() {
    console.log = this.originalConsoleLog;
  }
}

// Apply the safe logger
const safeLogger = new SafeLogger();

// Disable debug logs in any libraries that respect these environment variables
process.env.DEBUG = '';  // Disable debug logs
process.env.NODE_DEBUG = ''; // Disable Node.js internal debugging
process.env.DEBUG_COLORS = 'no'; // Disable color output in logs
process.env.NODE_ENV = process.env.NODE_ENV || 'production'; // Use production mode by default
process.env.LOG_LEVEL = 'error'; // Set log level to error only
process.env.SILENT = 'true'; // Some libraries respect this
process.env.QUIET = 'true'; // Some libraries respect this

// IMPORTANT: Don't globally override stdout as it breaks MCP protocol
// We'll use more targeted approaches in specific methods

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

import { Memory } from "mem0ai/oss"; // For local in-memory storage
// Using dynamic import for cloud API to avoid TypeScript issues
let MemoryClient: any = null;

// Type for the arguments received by the MCP tool handlers
interface Mem0AddToolArgs {
  content: string;
  userId: string;
  sessionId?: string;
  agentId?: string;
  metadata?: any;
}

interface Mem0SearchToolArgs {
  query: string;
  userId: string;
  sessionId?: string;
  agentId?: string;
  filters?: any;
  threshold?: number;
}

interface Mem0DeleteToolArgs {
  memoryId: string;
  userId: string;
  agentId?: string;
}

// Message type for Mem0 API
type Mem0Message = {
  role: "user" | "assistant" | "system";
  content: string;
};

class Mem0MCPServer {
  private server: Server;
  private isCloudMode: boolean = false;
  private localClient?: Memory;
  private cloudClient?: any;
  private isReady: boolean = false;

  constructor() {
    console.info("Initializing Mem0 MCP Server...");

    // Check for Mem0 API key first (for cloud mode)
    const mem0ApiKey = process.env.MEM0_API_KEY;

    // Check for OpenAI API key (for local mode)
    const openaiApiKey = process.env.OPENAI_API_KEY;

    // Initialize MCP Server
    this.server = new Server(
      {
        // Updated to fork's name and version
        name: "alexyangjie/mem0-mcp",
        version: "0.3.3",
      },
      {
        capabilities: {
          // Only tools capability needed for now
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Determine the mode based on available keys
    if (mem0ApiKey) {
      console.info("Using Mem0 cloud storage mode with MEM0_API_KEY");
      this.isCloudMode = true;

      // Dynamic import for cloud client
      import('mem0ai').then(module => {
        try {
          MemoryClient = module.default;
          // Get organization and project IDs
          const orgId = process.env.YOUR_ORG_ID || process.env.ORG_ID;
          const projectId = process.env.YOUR_PROJECT_ID || process.env.PROJECT_ID;

          // Initialize with all available options
          const clientOptions: any = {
            apiKey: mem0ApiKey,
            // Disable debug logs in the client if possible
            debug: false,
            verbose: false,
            silent: true
          };

          // Add org and project IDs if available
          if (orgId) clientOptions.org_id = orgId;
          if (projectId) clientOptions.project_id = projectId;

          this.cloudClient = new MemoryClient(clientOptions);
          console.info("Cloud client initialized successfully with options:", {
            hasApiKey: !!mem0ApiKey,
            hasOrgId: !!orgId,
            hasProjectId: !!projectId
          });
          this.isReady = true;
        } catch (error) {
          console.error("Error in cloud client initialization:", error);
        }
      }).catch(error => {
        console.error("Error initializing cloud client:", error);
        process.exit(1);
      });
    } else if (openaiApiKey) {
      console.info("Using local in-memory storage mode with OPENAI_API_KEY");
      this.isCloudMode = false;

      try {
        // Configure embedder using OpenAI
        const embeddingsModel = process.env.EMBEDDING_MODEL || "text-embedding-3-large";
        const embeddingModelDimsStr = process.env.EMBEDDING_MODEL_DIMS || "3072";
        const embeddingModelDims = parseInt(embeddingModelDimsStr, 10);
        const embedderConfig = {
          provider: "openai",
          config: {
            apiKey: openaiApiKey!,
            model: embeddingsModel
          }
        };

        // Configure vector store based on environment variable
        const vectorDbProvider = process.env.VECTOR_DB_PROVIDER;
        let vectorStoreConfig: any;
        if (vectorDbProvider === "qdrant") {
          const url = process.env.VECTOR_DB_URL;
          if (!url) {
            console.error("Error: VECTOR_DB_URL must be set when VECTOR_DB_PROVIDER=qdrant");
            process.exit(1);
          }
          const collectionName = process.env.VECTOR_DB_COLLECTION_NAME || "memories";
          const apiKey = process.env.VECTOR_DB_API_KEY || undefined;
          vectorStoreConfig = {
            provider: "qdrant",
            config: { collectionName, embeddingModelDims, url, apiKey }
          };
        } else {
          const collectionName = process.env.VECTOR_DB_COLLECTION_NAME || "mem0_default_collection";
          vectorStoreConfig = {
            provider: "memory",
            config: { collectionName }
          };
        }

        this.localClient = new Memory({
          embedder: embedderConfig,
          vectorStore: vectorStoreConfig
        });
        console.info("Local client initialized successfully with custom configuration");
        this.isReady = true;
      } catch (error: any) {
        console.error("Error initializing local client:", error);
        process.exit(1);
      }
    } else {
      console.error("Error: Either MEM0_API_KEY (for cloud storage) or OPENAI_API_KEY (for local storage) must be provided.");
      process.exit(1);
    }

    process.on('SIGINT', async () => {
      console.info("Received SIGINT signal, shutting down...");
      // Restore original console.log before exit
      safeLogger.restore();
      await this.server.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.info("Received SIGTERM signal, shutting down...");
      // Restore original console.log before exit
      safeLogger.restore();
      await this.server.close();
      process.exit(0);
    });

    // Cleanup on uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error("Uncaught exception:", error);
      // Restore original console.log before exit
      safeLogger.restore();
      process.exit(1);
    });
  }

  /**
   * Sets up handlers for MCP tool-related requests.
   */
  private setupToolHandlers(): void {
    // Handler for listing available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "add_memory",
            description: "Stores a piece of text as a memory in Mem0.",
            inputSchema: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description: "The text content to store as memory.",
                },
                userId: {
                  type: "string",
                  description: "User ID to associate with the memory.",
                },
                sessionId: {
                  type: "string",
                  description: "Optional session ID to associate with the memory.",
                },
                agentId: {
                  type: "string",
                  description: "Optional agent ID to associate with the memory (for cloud API).",
                },
                metadata: {
                  type: "object",
                  description: "Optional key-value metadata.",
                },
              },
              required: ["content", "userId"],
            },
          },
          {
            name: "search_memory",
            description: "Searches stored memories in Mem0 based on a query.",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The search query.",
                },
                userId: {
                  type: "string",
                  description: "User ID to filter search.",
                },
                sessionId: {
                  type: "string",
                  description: "Optional session ID to filter search.",
                },
                agentId: {
                  type: "string",
                  description: "Optional agent ID to filter search (for cloud API).",
                },
                filters: {
                  type: "object",
                  description: "Optional key-value filters for metadata.",
                },
                threshold: {
                  type: "number",
                  description: "Optional similarity threshold for results (for cloud API).",
                },
              },
              required: ["query", "userId"],
            },
          },
          {
            name: "delete_memory",
            description: "Deletes a specific memory by ID from Mem0.",
            inputSchema: {
              type: "object",
              properties: {
                memoryId: {
                  type: "string",
                  description: "The unique ID of the memory to delete.",
                },
                userId: {
                  type: "string",
                  description: "User ID associated with the memory.",
                },
                agentId: {
                  type: "string",
                  description: "Optional agent ID associated with the memory (for cloud API).",
                },
              },
              required: ["memoryId", "userId"],
            },
          },
        ],
      };
    });

    // Handler for call tool requests
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!this.isReady) {
        throw new McpError(ErrorCode.InternalError, "Memory client is still initializing. Please try again in a moment.");
      }

      try {
        const { name } = request.params;
        const args = request.params.arguments || {};

        if (name === "add_memory") {
          const toolArgs = args as unknown as Mem0AddToolArgs;
          return await this.handleAddMemory(toolArgs);
        } else if (name === "search_memory") {
          const toolArgs = args as unknown as Mem0SearchToolArgs;
          return await this.handleSearchMemory(toolArgs);
        } else if (name === "delete_memory") {
          const toolArgs = args as unknown as Mem0DeleteToolArgs;
          return await this.handleDeleteMemory(toolArgs);
        } else {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error: any) {
        if (error instanceof McpError) {
          throw error;
        }

        console.error(`Error executing tool:`, error);
        throw new McpError(ErrorCode.InternalError, `Error executing tool: ${error.message || 'Unknown error'}`);
      }
    });
  }

  /**
   * Handles adding a memory using either local or cloud client.
   */
  private async handleAddMemory(args: Mem0AddToolArgs): Promise<any> {
    const { content, userId, sessionId, agentId, metadata } = args;

    if (!content) {
      throw new McpError(ErrorCode.InvalidParams, "Missing required argument: content");
    }

    if (!userId) {
      throw new McpError(ErrorCode.InvalidParams, "Missing required argument: userId");
    }

    console.info(`Queueing memory addition for user ${userId}`);

    // Prepare message payload for embedding/storage
    const messages: Mem0Message[] = [{ role: "user", content }];

    if (this.isCloudMode && this.cloudClient) {
      const cloudClient = this.cloudClient;
      const orgId = process.env.YOUR_ORG_ID || process.env.ORG_ID;
      const projectId = process.env.YOUR_PROJECT_ID || process.env.PROJECT_ID;
      const options: any = {
        user_id: userId,
        version: "v2"
      };
      if (orgId) options.org_id = orgId;
      if (projectId) options.project_id = projectId;
      if (sessionId) options.run_id = sessionId;
      if (agentId) options.agent_id = agentId;
      if (metadata) options.metadata = metadata;

      // Fire-and-forget: perform embedding and storage asynchronously
      void (async () => {
        try {
          await cloudClient.add(messages, options);
          console.info("Memory added asynchronously (cloud)");
        } catch (err: any) {
          console.error("Async error adding memory (cloud):", err);
        }
      })();

    } else if (this.localClient) {
      const localClient = this.localClient;
      const options: any = { userId, sessionId, metadata };

      void (async () => {
        try {
          await localClient.add(messages, options);
        console.info("Memory added asynchronously (local)");
        } catch (err: any) {
          console.error("Async error adding memory (local):", err);
        }
      })();

    } else {
      throw new McpError(ErrorCode.InternalError, "No memory client is available");
    }

    // Immediate response to MCP caller
    return {
      content: [{ type: "text", text: `Memory addition queued successfully` }],
    };
  }

  /**
   * Handles searching memories using either local or cloud client.
   */
  private async handleSearchMemory(args: Mem0SearchToolArgs): Promise<any> {
    const { query, userId, sessionId, agentId, filters, threshold } = args;

    if (!query) {
      throw new McpError(ErrorCode.InvalidParams, "Missing required argument: query");
    }

    if (!userId) {
      throw new McpError(ErrorCode.InvalidParams, "Missing required argument: userId");
    }

    if (this.isCloudMode && this.cloudClient) {
      try {
        // Get organization and project IDs
        const orgId = process.env.YOUR_ORG_ID || process.env.ORG_ID;
        const projectId = process.env.YOUR_PROJECT_ID || process.env.PROJECT_ID;

        // Cloud API options
        const options: any = {
          user_id: userId,
          version: "v2"
        };

        // Add organization and project IDs if available
        if (orgId) options.org_id = orgId;
        if (projectId) options.project_id = projectId;

        // Map sessionId to run_id for Mem0 API compatibility
        if (sessionId) options.run_id = sessionId;
        if (agentId) options.agent_id = agentId;
        if (filters) options.filters = filters;
        // Only add threshold if it's a valid number (not null or undefined)
        if (threshold !== undefined && threshold !== null) {
          options.threshold = threshold;
        } else {
          // Use the default threshold value from Mem0 API (0.3)
          options.threshold = 0.3;
        }

        // API call
        const results = await this.cloudClient.search(query, options);

        // Handle potential array or object result
        const resultsArray = Array.isArray(results) ? results : [results];
        console.info(`Found ${resultsArray.length} memories using cloud API`);

        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      } catch (error: any) {
        console.error("Error searching memories using cloud API:", error);
        throw new McpError(ErrorCode.InternalError, `Error searching memories: ${error.message}`);
      }
    } else if (this.localClient) {
      try {
        // Local storage options (apply threshold filtering similar to cloud mode)
        const options: any = { userId, sessionId, filters };
        if (threshold !== undefined && threshold !== null) {
          options.threshold = threshold;
        } else {
          options.threshold = 0.3;
        }

        // API call
        const results = await this.localClient.search(query, options);

        // Handle potential array or object result
        const resultsArray = Array.isArray(results) ? results : [results];
        console.info(`Found ${resultsArray.length} memories using local storage`);

        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      } catch (error: any) {
        console.error("Error searching memories using local storage:", error);
        throw new McpError(ErrorCode.InternalError, `Error searching memories: ${error.message}`);
      }
    } else {
      throw new McpError(ErrorCode.InternalError, "No memory client is available");
    }
  }

  /**
   * Handles deleting a memory using either local or cloud client.
   */
  private async handleDeleteMemory(args: Mem0DeleteToolArgs): Promise<any> {
    const { memoryId, userId, agentId } = args;

    if (!memoryId) {
      throw new McpError(ErrorCode.InvalidParams, "Missing required argument: memoryId");
    }

    if (!userId) {
      throw new McpError(ErrorCode.InvalidParams, "Missing required argument: userId");
    }

    console.info(`Attempting to delete memory with ID ${memoryId} for user ${userId}`);

    if (this.isCloudMode && this.cloudClient) {
      try {
        // Get organization and project IDs
        const orgId = process.env.YOUR_ORG_ID || process.env.ORG_ID;
        const projectId = process.env.YOUR_PROJECT_ID || process.env.PROJECT_ID;

        // Cloud API options - using snake_case
        const options: any = {
          memory_id: memoryId,
          user_id: userId,
          version: "v2"
        };

        // Add organization and project IDs if available
        if (orgId) options.org_id = orgId;
        if (projectId) options.project_id = projectId;

        if (agentId) options.agent_id = agentId;

        // Try to use the API's deleteMemory method through the client
        try {
          // @ts-ignore - We'll try to access this method even if TypeScript doesn't recognize it
          await this.cloudClient.deleteMemory(memoryId);
          console.info(`Memory ${memoryId} deleted successfully using cloud API's deleteMemory`);
        } catch (innerError) {
          // If that fails, try to use a generic request method
          console.info("Using fallback delete method for cloud API");
          await fetch(`https://api.mem0.ai/v2/memories/${memoryId}`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Token ${process.env.MEM0_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(options)
          });
          console.info(`Memory ${memoryId} deleted successfully using direct API request`);
        }

        return {
          content: [{ type: "text", text: `Memory ${memoryId} deleted successfully` }],
        };
      } catch (error: any) {
        console.error("Error deleting memory using cloud API:", error);
        throw new McpError(ErrorCode.InternalError, `Error deleting memory: ${error.message}`);
      }
    } else if (this.localClient) {
      try {
        // For local storage, we need to find a way to delete the memory
        // Since we don't have direct access to deleteMemory, we'll try to access it indirectly

        try {
          // @ts-ignore - We'll try to access this method even if TypeScript doesn't recognize it
          await this.localClient.deleteMemory(memoryId);
          console.info(`Memory ${memoryId} deleted successfully using local storage deleteMemory`);
        } catch (innerError) {
          // If direct method fails, try to access through any internal methods
          console.info("Using fallback delete method for local storage");

          // @ts-ignore - Accessing potentially private properties
          if (this.localClient._vectorstore && typeof this.localClient._vectorstore.delete === 'function') {
            // @ts-ignore
            await this.localClient._vectorstore.delete({ ids: [memoryId] });
            console.info(`Memory ${memoryId} deleted successfully using vectorstore delete`);
          } else {
            throw new Error("Local client does not support memory deletion");
          }
        }

        return {
          content: [{ type: "text", text: `Memory ${memoryId} deleted successfully` }],
        };
      } catch (error: any) {
        console.error("Error deleting memory using local storage:", error);
        throw new McpError(ErrorCode.InternalError, `Error deleting memory: ${error.message || "Local client does not support memory deletion"}`);
      }
    } else {
      throw new McpError(ErrorCode.InternalError, "No memory client is available");
    }
  }

  /**
   * Starts the MCP server.
   */
  public async start(): Promise<void> {
    console.info("Starting Mem0 MCP Server...");
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.info("Mem0 MCP Server is running.");
  }
}

// Start the server
const server = new Mem0MCPServer();
server.start().catch((error) => {
  console.error("Failed to start server:", error);
  // Restore original console.log before exit
  safeLogger.restore();
  process.exit(1);
});
