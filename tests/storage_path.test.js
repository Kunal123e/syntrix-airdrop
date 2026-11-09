const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const test = require("node:test");
const processQueueRouter = require("../routes/processQueue");
const uploadBatchRouter = require("../routes/uploadBatch");
const { getUserStoragePathSegment } = require("../storagePaths");

test("three-file batch URLs resolve to the exact uploaded paths for URL-reserved email characters", async t => {
  const uploadedObjects = new Map();
  let insertedJobs = [];
  let nextBatchId = 0;
  const supabase = {
    from(table) {
      let operation = null;
      const builder = {
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        limit() { return this; },
        insert(values) {
          operation = { type: "insert", values };
          return this;
        },
        single: async () => ({ data: { id: `batch-${++nextBatchId}` }, error: null }),
        then(resolve, reject) {
          let result = { data: [], error: null };
          if (table === "upload_jobs" && operation?.type === "insert") {
            insertedJobs = operation.values;
            result = {
              data: operation.values.map((job, index) => ({
                id: `job-${index + 1}`,
                file_name: job.file_name,
                status: job.status
              })),
              error: null
            };
          }
          return Promise.resolve(result).then(resolve, reject);
        }
      };
      return builder;
    },
    storage: {
      from(bucket) {
        return {
          async upload(path, buffer) {
            uploadedObjects.set(`${bucket}/${path}`, Buffer.from(buffer));
            return { error: null };
          },
          getPublicUrl(path) {
            return {
              data: {
                publicUrl: encodeURI(`https://storage.example/storage/v1/object/public/${bucket}/${path}`)
              }
            };
          }
        };
      }
    }
  };
  const app = express();
  app.use(express.json());
  app.locals.supabase = supabase;
  app.use("/api/uploads/batch", uploadBatchRouter);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));

  const email = "name?tag#fragment@example.test";
  const files = [0, 1, 2].map(index => ({
    taskType: "document",
    fileName: `notes-${index}.jpg`,
    imageBase64: Buffer.alloc(2048, index + 1).toString("base64")
  }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/uploads/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userEmail: email, files })
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).totalQueued, 3);
  assert.equal(insertedJobs.length, 3);
  assert.equal(uploadedObjects.size, 3);
  assert.equal(getUserStoragePathSegment(email), Buffer.from(email).toString("base64url"));

  for (const job of insertedJobs) {
    const url = new URL(job.storage_url);
    const path = processQueueRouter.getBucketPathFromUrl(job.storage_url, job.file_name);
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    assert.ok(path.startsWith(`queue/${getUserStoragePathSegment(email)}/`));
    assert.ok(uploadedObjects.has(`verified_assets/${path}`), "job URL must resolve to the key uploaded for the job");
  }
});

test("legacy public URLs preserve reserved characters in the stored object key", async () => {
  const legacyPath = "queue/name?tag#fragment@example.test/123_0_notes.jpg";
  const legacyUrl = encodeURI(`https://storage.example/storage/v1/object/public/verified_assets/${legacyPath}`);
  const resolvedPath = processQueueRouter.getBucketPathFromUrl(legacyUrl, "123_0_notes.jpg");
  const originalFetch = global.fetch;
  let fetchedUrl;
  global.fetch = async url => {
    fetchedUrl = url;
    return new Response(Buffer.from("available"), { status: 200 });
  };

  try {
    assert.equal(resolvedPath, legacyPath);
    await processQueueRouter.downloadUploadImage({
      storage: {
        from() {
          return {
            download: async () => ({
              data: null,
              error: { message: "Object not found", statusCode: 404 }
            })
          };
        }
      }
    }, legacyUrl, resolvedPath);
    assert.equal(
      fetchedUrl,
      "https://storage.example/storage/v1/object/public/verified_assets/queue/name%3Ftag%23fragment%40example.test/123_0_notes.jpg"
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("URL query options are not treated as part of the stored object path", () => {
  assert.equal(
    processQueueRouter.getBucketPathFromUrl(
      "https://storage.example/verified_assets/queue/notes.jpg?download=1",
      "notes.jpg"
    ),
    "queue/notes.jpg"
  );
});

test("a Storage SDK 404 falls back to the public URL before treating an asset as missing", async () => {
  const originalFetch = global.fetch;
  const expectedBuffer = Buffer.from("public storage fallback");
  let requestedUrl;
  global.fetch = async url => {
    requestedUrl = url;
    return new Response(expectedBuffer, { status: 200 });
  };

  try {
    const result = await processQueueRouter.downloadUploadImage({
      storage: {
        from() {
          return {
            download: async () => ({
              data: null,
              error: { message: "Object not found", statusCode: 404 }
            })
          };
        }
      }
    }, "https://storage.example/object/public/verified_assets/queue/notes.jpg", "queue/notes.jpg");

    assert.equal(requestedUrl, "https://storage.example/object/public/verified_assets/queue/notes.jpg");
    assert.deepEqual(result, expectedBuffer);
  } finally {
    global.fetch = originalFetch;
  }
});

test("an SDK and public URL 404 still produce a fatal missing-asset result", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(null, { status: 404 });

  try {
    await assert.rejects(
      processQueueRouter.downloadUploadImage({
        storage: {
          from() {
            return {
              download: async () => ({
                data: null,
                error: { message: "Object not found", statusCode: 404 }
              })
            };
          }
        }
      }, "https://storage.example/object/public/verified_assets/queue/missing.jpg", "queue/missing.jpg"),
      error => error.isFatal === true && error.errorCode === "ASSET_NOT_FOUND"
    );
  } finally {
    global.fetch = originalFetch;
  }
});
