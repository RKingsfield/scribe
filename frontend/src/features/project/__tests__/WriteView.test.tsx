import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { WriteView } from '../WriteView';
import type { ProjectContext } from '../ProjectView';
import { tree } from './fixtures';

const context: ProjectContext = {
  slug: 'demo',
  tree,
  refreshTree: () => {},
  setHeader: () => {},
};

describe('WriteView', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route index element={<WriteView />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(container.querySelector('.write-shell')).toBeTruthy();
  });
});
