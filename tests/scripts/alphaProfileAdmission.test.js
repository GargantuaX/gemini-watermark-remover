import test from 'node:test';
import assert from 'node:assert/strict';

const admissionModule = await import('../../scripts/alpha-profile-admission.js').catch(() => ({}));

test('alpha profile admission promotes only trials that are relatively safer and absolutely clean', () => {
    assert.equal(typeof admissionModule.buildAlphaProfileAdmission, 'function');

    const current = {
        spatial: 0.18,
        gradient: 0.05,
        positiveHaloLum: 12,
        visualArtifactCost: 0.08
    };
    const relativelyImprovedButVisible = {
        spatial: 0.17,
        gradient: 0.04,
        positiveHaloLum: 10,
        visualArtifactCost: 0.07,
        visible: true,
        visiblePositiveHalo: true,
        bandProfile: {
            edge: { positiveDeltaLum: 0 },
            'mid-core': { positiveDeltaLum: 10 },
            'high-core': { positiveDeltaLum: 14 }
        }
    };
    const relativelyImprovedAndClean = {
        spatial: 0.02,
        gradient: 0.03,
        positiveHaloLum: 0.3,
        visualArtifactCost: 0.04,
        visible: false,
        visiblePositiveHalo: false,
        bandProfile: {
            edge: { positiveDeltaLum: 0.2 },
            'mid-core': { positiveDeltaLum: 0.3 },
            'high-core': { positiveDeltaLum: 0.4 }
        }
    };

    const visibleAdmission = admissionModule.buildAlphaProfileAdmission({
        current,
        trial: relativelyImprovedButVisible
    });
    const cleanAdmission = admissionModule.buildAlphaProfileAdmission({
        current,
        trial: relativelyImprovedAndClean
    });

    assert.equal(visibleAdmission.productionCandidate, false);
    assert.equal(visibleAdmission.absoluteClean, false);
    assert.equal(cleanAdmission.productionCandidate, true);
    assert.equal(cleanAdmission.absoluteClean, true);
});
