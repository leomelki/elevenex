import { findBinary } from '../config/system-paths.js';
import { shouldUseTmux } from '../config/backend-runtime-mode.js';
import { TmuxManager } from './tmux-manager.service.js';

jest.mock('../config/system-paths.js', () => ({
  findBinary: jest.fn(),
}));

jest.mock('../config/backend-runtime-mode.js', () => ({
  shouldUseTmux: jest.fn(),
}));

describe('TmuxManager', () => {
  const mockFindBinary = jest.mocked(findBinary);
  const mockShouldUseTmux = jest.mocked(shouldUseTmux);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('does not inspect PATH when tmux is disabled for a local backend', () => {
    mockShouldUseTmux.mockReturnValue(false);
    mockFindBinary.mockReturnValue('/usr/bin/tmux');

    const manager = new TmuxManager();

    expect(manager.isTmuxRequired()).toBe(false);
    expect(manager.isTmuxAvailable()).toBe(false);
    expect(manager.getTmuxBin()).toBe('');
    expect(mockFindBinary).not.toHaveBeenCalled();
  });

  it('detects tmux for remote POSIX persistence', () => {
    mockShouldUseTmux.mockReturnValue(true);
    mockFindBinary.mockReturnValue('/usr/bin/tmux');

    const manager = new TmuxManager();

    expect(manager.isTmuxRequired()).toBe(true);
    expect(manager.isTmuxAvailable()).toBe(true);
    expect(manager.getTmuxBin()).toBe('/usr/bin/tmux');
  });
});
