import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ProjectPicker } from '../features/projects/ProjectPicker';
import { ProjectView } from '../features/project/ProjectView';
import { WriteView } from '../features/project/WriteView';
import { PlanBoard } from '../features/project/PlanBoard';
import { ChatView } from '../features/chat/ChatView';
import { ReviewView } from '../features/project/ReviewView';
import { BetaReaderView } from '../features/review/BetaReaderView';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ProjectPicker />} />
        <Route path="/review/t/:token" element={<BetaReaderView />} />
        <Route path="/p/:slug" element={<ProjectView />}>
          <Route index element={<Navigate to="write" replace />} />
          <Route path="write" element={<WriteView />} />
          <Route path="plan" element={<PlanBoard />} />
          <Route path="chat" element={<ChatView />} />
          <Route path="review" element={<ReviewView />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
