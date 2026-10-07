import { defineProject } from 'vitest/config';
export default defineProject({ test: { name: 'room-engine', include: ['src/**/*.test.ts'] } });
