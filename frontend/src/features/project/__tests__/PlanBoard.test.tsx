import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { PlanBoard } from '../PlanBoard';
import type { ProjectContext } from '../ProjectView';
import { tree } from './fixtures';

const context: ProjectContext = {
  slug: 'demo',
  tree,
  refreshTree: () => {},
  setHeader: () => {},
};

describe('PlanBoard', () => {
  it('renders outline mode without crashing', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route index element={<PlanBoard />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(container.querySelector('.corkboard-shell')).toBeTruthy();
  });
});
