import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { tuff } from '../../src/tuff.js';
import { makeTempDir, cleanup } from './helpers.js';

describe('J8 — Multi-stage varying concurrency', () => {
  test('embed concurrency=8 for 20 steps, classify concurrency=2 for 10 steps', async () => {
    const stateDir = makeTempDir();
    const progressLabels: string[] = [];

    try {
      await tuff(
        'j8',
        {
          stateDir,
          concurrency: 1,
          onProgress: (p) => progressLabels.push(p.stage),
        },
        async (ctx) => {
          // Stage 1: embed — 20 steps at concurrency=8
          ctx.stage('embed', { concurrency: 8 });

          let embedConcurrent = 0;
          let embedMax = 0;

          await Promise.all(
            Array.from({ length: 20 }, (_, i) =>
              ctx.step(`embed-${i}`, async () => {
                embedConcurrent++;
                embedMax = Math.max(embedMax, embedConcurrent);
                await new Promise((resolve) => setTimeout(resolve, 10));
                embedConcurrent--;
                return i;
              }),
            ),
          );

          assert.ok(embedMax <= 8, `embed maxConcurrent=${embedMax}, expected <= 8`);

          // Stage 2: classify — 10 steps at concurrency=2
          ctx.stage('classify', { concurrency: 2 });

          let classifyConcurrent = 0;
          let classifyMax = 0;

          await Promise.all(
            Array.from({ length: 10 }, (_, i) =>
              ctx.step(`classify-${i}`, async () => {
                classifyConcurrent++;
                classifyMax = Math.max(classifyConcurrent, classifyMax);
                await new Promise((resolve) => setTimeout(resolve, 10));
                classifyConcurrent--;
                return i;
              }),
            ),
          );

          assert.ok(classifyMax <= 2, `classify maxConcurrent=${classifyMax}, expected <= 2`);

          return { embedMax, classifyMax };
        },
      );

      // Progress events should span both stage labels
      const uniqueLabels = [...new Set(progressLabels)];
      assert.ok(uniqueLabels.includes('embed'), 'should have embed stage progress');
      assert.ok(uniqueLabels.includes('classify'), 'should have classify stage progress');

      // Verify label ordering: embed before classify
      const firstEmbed = progressLabels.indexOf('embed');
      const firstClassify = progressLabels.indexOf('classify');
      assert.ok(firstEmbed < firstClassify, 'embed stage should come before classify');
    } finally {
      cleanup(stateDir);
    }
  });
});
