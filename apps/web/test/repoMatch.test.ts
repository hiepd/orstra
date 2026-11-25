import { describe, expect, it } from 'vitest';
import { matchRepos } from '../src/lib/repoMatch';

const repos = ['/Users/me/workspace/hub', '/Users/me/workspace/github-tools', '/Users/me/code/orstra', '/Users/me/src/acme/hubble', '/Users/me/src/acme/api'];

describe('matchRepos', () => {
  it('shows all repos, short, when you have typed nothing', () => {
    expect(matchRepos(repos, '')).toEqual(['~/workspace/hub', '~/workspace/github-tools', '~/code/orstra', '~/src/acme/hubble', '~/src/acme/api']);
  });

  it('puts a name that starts with what you typed first, then a name that has it, then a path that has it', () => {
    expect(matchRepos(repos, 'hub')).toEqual(['~/workspace/hub', '~/src/acme/hubble', '~/workspace/github-tools']);
    expect(matchRepos(repos, 'acme')).toEqual(['~/src/acme/hubble', '~/src/acme/api']);
  });

  it('matches a typed path, with ~ or in full, and ignores case', () => {
    expect(matchRepos(repos, '~/code/')).toEqual(['~/code/orstra']);
    expect(matchRepos(repos, '/Users/me/CODE')).toEqual(['~/code/orstra']);
  });

  it('hides the list when what you typed is already a suggestion', () => {
    expect(matchRepos(repos, '~/workspace/hub')).toEqual([]);
  });

  it('shows 8 at most', () => {
    expect(matchRepos(Array.from({ length: 12 }, (_, i) => `/Users/me/src/r${i}`), '')).toHaveLength(8);
  });
});
