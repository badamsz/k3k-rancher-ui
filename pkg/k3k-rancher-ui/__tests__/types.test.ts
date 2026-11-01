import { K3S_IMAGE_TAG, normalizeK3sVersion } from '../types';

describe('normalizeK3sVersion', () => {
  it.each([
    ['v1.36.5+k3s1', 'v1.36.5-k3s1'],
    ['v1.36.5-k3s1', 'v1.36.5-k3s1'],
    [' 1.36.5 ', 'v1.36.5-k3s1'],
    ['v1.36.6-rc1+k3s1', 'v1.36.6-rc1-k3s1'],
    ['', ''],
    [undefined, ''],
  ])('%p -> %p', (input, expected) => {
    expect(normalizeK3sVersion(input)).toBe(expected);
  });

  it('produces valid image tags and rejects garbage', () => {
    expect(K3S_IMAGE_TAG.test(normalizeK3sVersion('v1.36.5+k3s1'))).toBe(true);
    expect(K3S_IMAGE_TAG.test(normalizeK3sVersion('latest'))).toBe(false);
  });
});

describe('toReleaseName', () => {
  it('converts image tags back to K3s release names', () => {
    const { toReleaseName } = jest.requireActual('../types');

    expect(toReleaseName('v1.36.5-k3s1')).toBe('v1.36.5+k3s1');
    expect(toReleaseName('v1.36.6-rc1-k3s2')).toBe('v1.36.6-rc1+k3s2');
    expect(toReleaseName(undefined)).toBe('');
  });
});
