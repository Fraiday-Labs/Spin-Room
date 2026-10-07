process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://spinroom:spinroom@localhost:5432/spinroom_test';
process.env.REDIS_URL ??= 'redis://localhost:6379/15';
process.env.SPOTIFY_MODE ??= 'fake';
process.env.STORAGE_DIR ??= '.data/test-blobs';
