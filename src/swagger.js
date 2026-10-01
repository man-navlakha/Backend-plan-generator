const swaggerJSDoc = require('swagger-jsdoc');
const path = require('path');

const definition = {
  openapi: '3.0.3',
  info: {
    title: 'Backend Plan Generator API',
    version: process.env.npm_package_version || '1.0.0',
    description:
      'Media plan generation plus the read-only catalog browse APIs (transit, radio, cinema and the ' +
      'other masters) that back the internal portals.'
  },
  servers: [
    { url: '/', description: 'Current host' }
  ],
  tags: [
    { name: 'Health', description: 'Liveness and readiness probes' },
    { name: 'Brief', description: 'Validate a deal brief and list plannable media' },
    { name: 'Plans', description: 'Generate, fetch and list media plans' },
    { name: 'Transit catalog', description: 'Read-only browse API for the transit master' },
    { name: 'Radio catalog', description: 'Read-only browse API for the radio master' },
    { name: 'Cinema catalog', description: 'Read-only browse API for the cinema master' },
    { name: 'Masters catalog', description: 'Read-only browse API shared by the other masters (magazine, and the cinema/radio/transit masters by slug)' }
  ],
  components: {
    schemas: {
      Error: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'error' },
          code: { type: 'string', example: 'invalid_request' },
          message: { type: 'string', example: 'Deal ID is required' },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                message: { type: 'string' }
              }
            }
          }
        }
      },
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer', example: 1 },
          page_size: { type: 'integer', example: 24 },
          total: { type: 'integer', example: 120 },
          pages: { type: 'integer', example: 5 },
          show_all: { type: 'boolean' }
        }
      }
    },
    securitySchemes: {
      CrmApiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'Also accepted as `Authorization: Bearer <key>`. Required for /plans/generate.'
      }
    }
  }
};

const options = {
  definition,
  // glob (used internally by swagger-jsdoc) only understands forward slashes.
  apis: [path.join(__dirname, 'routes', '*.js').split(path.sep).join('/')]
};

module.exports = swaggerJSDoc(options);
