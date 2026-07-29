import assert from 'node:assert/strict';
import test from 'node:test';

import {
    summarizeShadowResidualProfileRecords
} from '../../scripts/run-shadow-residual-profile-ensemble.js';

test('summarizes directional evidence only when directional records are present', () => {
    const summary = summarizeShadowResidualProfileRecords([
        {
            rUnder: { bestJointEvidence: 0.4 },
            dOver: { bestJointEvidence: 0.1 },
            q: {
                evidenceAvailability: 'complete',
                attemptedTrialCount: 10,
                validTrialCount: 10,
                inBoundsTrialCount: 10
            }
        },
        {
            rUnder: { bestJointEvidence: 0.2 },
            dOver: { bestJointEvidence: 0.5 },
            q: {
                evidenceAvailability: 'complete',
                attemptedTrialCount: 10,
                validTrialCount: 10,
                inBoundsTrialCount: 10
            }
        },
        {
            rUnder: null,
            dOver: null,
            q: {
                evidenceAvailability: 'unavailable',
                attemptedTrialCount: 0,
                validTrialCount: 0,
                inBoundsTrialCount: 0
            }
        }
    ]);

    assert.deepEqual(
        summary.continuousEvidence.underRemovalBestJoint,
        {
            count: 2,
            p50: 0.2,
            p90: 0.4,
            p95: 0.4
        }
    );
    assert.deepEqual(
        summary.continuousEvidence.overRemovalBestJoint,
        {
            count: 2,
            p50: 0.1,
            p90: 0.5,
            p95: 0.5
        }
    );
    assert.equal(summary.decisionSemantics, 'none');
    assert.equal('verdict' in summary, false);
    assert.equal('clean' in summary, false);
});
