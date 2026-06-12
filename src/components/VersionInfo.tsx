import React from 'react';

export const VersionInfo: React.FC = () => {
  return (
    <div className="text-xs text-opacity-50 text-text-main text-center py-2 font-mono">
      Version: {__COMMIT_HASH__} | Built: {__BUILD_TIME__}
    </div>
  );
};
