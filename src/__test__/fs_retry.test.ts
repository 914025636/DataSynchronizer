import { promises as fsp } from 'fs';
import { renameWithRetry } from '../utils/fs_retry';

const errno = (code: string) => Object.assign(new Error(code), { code });

afterEach(() => jest.restoreAllMocks());

it('retries a rename that Windows briefly blocks', async () => {
  const rename = jest.spyOn(fsp, 'rename')
    .mockRejectedValueOnce(errno('EPERM'))
    .mockRejectedValueOnce(errno('EBUSY'))
    .mockResolvedValueOnce(undefined);
  await renameWithRetry('from', 'to', 5, 1);
  expect(rename).toHaveBeenCalledTimes(3);
});

it('fails fast on errors retrying cannot fix', async () => {
  const rename = jest.spyOn(fsp, 'rename').mockRejectedValue(errno('ENOENT'));
  await expect(renameWithRetry('from', 'to', 5, 1)).rejects.toThrow('ENOENT');
  expect(rename).toHaveBeenCalledTimes(1);
});

it('gives up after the attempt limit', async () => {
  const rename = jest.spyOn(fsp, 'rename').mockRejectedValue(errno('EPERM'));
  await expect(renameWithRetry('from', 'to', 3, 1)).rejects.toThrow('EPERM');
  expect(rename).toHaveBeenCalledTimes(3);
});
